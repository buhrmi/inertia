import { router, setupProgress } from '@inertiajs/core'
import { render } from 'svelte/server';
import App from './App.svelte'
import SSR from './SSR.svelte'
import store from './store'

export default async function createInertiaApp({ id = 'app', resolve, setup, progress = {}, page }) {
  const isServer = typeof window === 'undefined'
  const el = isServer ? null : document.getElementById(id)
  const initialPage = page || JSON.parse(el.dataset.page)
  const resolveComponent = (name) => Promise.resolve(resolve(name))

  await resolveComponent(initialPage.component).then((initialComponent) => {
    store.set({
      component: initialComponent,
      page: initialPage,
    })
  })

  if (!isServer) {
    router.init({
      initialPage,
      resolveComponent,
      swapComponent: async ({ component, page, preserveState }) => {
        const targetFrame = page.target
        if (targetFrame) store.update((current) => ({
          ...current,
          frames: { ...current.frames, [targetFrame]: {component, props: page.props} }
        }))
        else store.update((current) => ({
          component,
          page,
          frames: current.frames,
          key: preserveState ? current.key : Date.now(),
        }))
      },
    })

    if (progress) {
      setupProgress(progress)
    }

    return setup({
      el,
      App,
      props: {
        initialPage,
        resolveComponent,
      },
    })
  }

  if (isServer) {
    const { html, head, css } = render(SSR, { props: {id, initialPage} })

    return {
      body: html,
      head: [
        head,
        `<style data-vite-css>${css.code}</style>`,
      ],
    }
  }
}
