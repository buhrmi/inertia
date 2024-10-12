import { hideProgress, revealProgress } from '.'
import { eventHandler } from './eventHandler'
import { fireBeforeEvent } from './events'
import { history } from './history'
import { InitialVisit } from './initialVisit'
import { page as currentPage } from './page'
import { polls } from './polls'
import { prefetchedRequests } from './prefetched'
import { Request } from './request'
import { RequestStream } from './requestStream'
import { Scroll } from './scroll'
import {
  ActiveVisit,
  GlobalEvent,
  GlobalEventNames,
  GlobalEventResult,
  InFlightPrefetch,
  Page,
  PendingVisit,
  PendingVisitOptions,
  PollOptions,
  PrefetchedResponse,
  PrefetchOptions,
  ReloadOptions,
  RequestPayload,
  RouterInitParams,
  Visit,
  VisitCallbacks,
  VisitHelperOptions,
  VisitOptions,
} from './types'
import { transformUrlAndData } from './url'

export class Router {
  protected frame
  
  protected syncRequestStream = new RequestStream({
    maxConcurrent: 1,
    interruptible: true,
  })

  protected asyncRequestStream = new RequestStream({
    maxConcurrent: Infinity,
    interruptible: false,
  })
  
  constructor({ frame, initialFrame, resolveComponent, swapComponent }: RouterInitParams) {
    this.frame = frame
    
    currentPage.init({
      frame,
      initialFrame,
      resolveComponent,
      swapComponent,
    })

    InitialVisit.handle()

    eventHandler.init()

    eventHandler.on('missingHistoryItem', () => {
      if (typeof window !== 'undefined') {
        this.visit(window.location.href, { preserveState: true, preserveScroll: true, replace: true })
      }
    })

    eventHandler.onGlobalEvent('navigate', () => {
      this.loadDeferredProps()
    })
  }

  public get(url: URL | string, data: RequestPayload = {}, options: VisitHelperOptions = {}): void {
    return this.visit(url, { ...options, method: 'get', data })
  }

  public post(url: URL | string, data: RequestPayload = {}, options: VisitHelperOptions = {}): void {
    return this.visit(url, { preserveState: true, ...options, method: 'post', data })
  }

  public put(url: URL | string, data: RequestPayload = {}, options: VisitHelperOptions = {}): void {
    return this.visit(url, { preserveState: true, ...options, method: 'put', data })
  }

  public patch(url: URL | string, data: RequestPayload = {}, options: VisitHelperOptions = {}): void {
    return this.visit(url, { preserveState: true, ...options, method: 'patch', data })
  }

  public delete(url: URL | string, options: Omit<VisitOptions, 'method'> = {}): void {
    return this.visit(url, { preserveState: true, ...options, method: 'delete' })
  }

  public reload(options: ReloadOptions = {}): void {
    if (typeof window === 'undefined') {
      return
    }

    return this.visit(window.location.href, {
      ...options,
      preserveScroll: true,
      preserveState: true,
      async: true,
      headers: {
        ...(options.headers || {}),
        'Cache-Control': 'no-cache',
      },
    })
  }

  public remember(data: unknown, key = 'default'): void {
    history.remember(this.frame, data, key)
  }

  public restore(key = 'default'): unknown {
    return history.restore(this.frame, key)
  }

  public on<TEventName extends GlobalEventNames>(
    type: TEventName,
    callback: (event: GlobalEvent<TEventName>) => GlobalEventResult<TEventName>,
  ): VoidFunction {
    return eventHandler.onGlobalEvent(type, callback)
  }

  public cancel(): void {
    this.syncRequestStream.cancelInFlight()
  }

  public cancelAll(): void {
    this.asyncRequestStream.cancelInFlight()
    this.syncRequestStream.cancelInFlight()
  }

  public poll(interval: number, requestOptions: ReloadOptions = {}, options: PollOptions = {}) {
    return polls.add(interval, () => this.reload(requestOptions), {
      autoStart: options.autoStart ?? true,
      keepAlive: options.keepAlive ?? false,
    })
  }

  public visit(href: string | URL, options: VisitOptions = {}): void {
    const visit: PendingVisit = this.getPendingVisit(href, {
      ...options,
      showProgress: options.showProgress ?? !options.async,
    })

    const events = this.getVisitEvents(options)

    // If either of these return false, we don't want to continue
    if (events.onBefore(visit) === false || !fireBeforeEvent(visit)) {
      return
    }

    const requestStream = visit.async ? this.asyncRequestStream : this.syncRequestStream

    requestStream.interruptInFlight()

    if (!currentPage.isCleared() && !visit.preserveUrl) {
      // Save scroll regions for the current page
      Scroll.save(currentPage.get())
    }

    const requestParams: PendingVisit & VisitCallbacks = {
      ...visit,
      ...events,
    }

    const prefetched = prefetchedRequests.get(requestParams)

    if (prefetched) {
      revealProgress(prefetched.inFlight)
      prefetchedRequests.use(prefetched, requestParams)
    } else {
      revealProgress(true)
      requestStream.send(Request.create(requestParams, currentPage.get()))
    }
  }

  public getCached(href: string | URL, options: VisitOptions = {}): InFlightPrefetch | PrefetchedResponse | null {
    return prefetchedRequests.findCached(this.getPrefetchParams(href, options))
  }

  public flush(href: string | URL, options: VisitOptions = {}): void {
    prefetchedRequests.remove(this.getPrefetchParams(href, options))
  }

  public flushAll(): void {
    prefetchedRequests.removeAll()
  }

  public getPrefetching(href: string | URL, options: VisitOptions = {}): InFlightPrefetch | PrefetchedResponse | null {
    return prefetchedRequests.findInFlight(this.getPrefetchParams(href, options))
  }

  public prefetch(href: string | URL, options: VisitOptions = {}, { cacheFor }: PrefetchOptions) {
    if (options.method !== 'get') {
      throw new Error('Prefetch requests must use the GET method')
    }

    const visit: PendingVisit = this.getPendingVisit(href, {
      ...options,
      async: true,
      showProgress: false,
      prefetch: true,
    })

    const events = this.getVisitEvents(options)

    // If either of these return false, we don't want to continue
    if (events.onBefore(visit) === false || !fireBeforeEvent(visit)) {
      return
    }

    hideProgress()

    this.asyncRequestStream.interruptInFlight()

    const requestParams: PendingVisit & VisitCallbacks = {
      ...visit,
      ...events,
    }

    prefetchedRequests.add(
      requestParams,
      (params) => {
        this.asyncRequestStream.send(Request.create(params, currentPage.get()))
      },
      { cacheFor },
    )
  }

  public clearHistory(): void {
    history.clear()
  }

  public decryptHistory(): Promise<Page> {
    return history.decrypt()
  }

  protected getPrefetchParams(href: string | URL, options: VisitOptions): ActiveVisit {
    return {
      ...this.getPendingVisit(href, {
        ...options,
        async: true,
        showProgress: false,
        prefetch: true,
      }),
      ...this.getVisitEvents(options),
    }
  }

  protected getPendingVisit(
    href: string | URL,
    options: VisitOptions,
    pendingVisitOptions: Partial<PendingVisitOptions> = {},
  ): PendingVisit {
    const mergedOptions: Visit = {
      method: 'get',
      data: {},
      replace: false,
      preserveScroll: false,
      preserveState: false,
      only: [],
      except: [],
      headers: {},
      errorBag: '',
      forceFormData: false,
      queryStringArrayFormat: 'brackets',
      async: false,
      showProgress: true,
      fresh: false,
      reset: [],
      preserveUrl: false,
      prefetch: false,
      frame: "_top",
      ...options,
    }

    const [url, _data] = transformUrlAndData(
      href,
      mergedOptions.data,
      mergedOptions.method,
      mergedOptions.forceFormData,
      mergedOptions.queryStringArrayFormat,
    )

    return {
      cancelled: false,
      completed: false,
      interrupted: false,
      ...mergedOptions,
      ...pendingVisitOptions,
      url,
      data: _data,
    }
  }

  protected getVisitEvents(options: VisitOptions): VisitCallbacks {
    return {
      onCancelToken: options.onCancelToken || (() => {}),
      onBefore: options.onBefore || (() => {}),
      onStart: options.onStart || (() => {}),
      onProgress: options.onProgress || (() => {}),
      onFinish: options.onFinish || (() => {}),
      onCancel: options.onCancel || (() => {}),
      onSuccess: options.onSuccess || (() => {}),
      onError: options.onError || (() => {}),
      onPrefetched: options.onPrefetched || (() => {}),
      onPrefetching: options.onPrefetching || (() => {}),
    }
  }

  protected loadDeferredProps(): void {
    const deferred = currentPage.frame(this.frame)?.deferredProps

    if (deferred) {
      Object.entries(deferred).forEach(([_, group]) => {
        this.reload({ only: group })
      })
    }
  }
}
