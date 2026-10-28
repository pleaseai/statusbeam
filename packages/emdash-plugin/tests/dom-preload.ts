import { GlobalRegistrator } from '@happy-dom/global-registrator'

/**
 * Preload for the admin component tests (`*.dom.tsx`): a DOM for React to render
 * into. Registered process-wide, so those tests run in their own `bun test`
 * call (`test:admin`), apart from the plain tests that expect no `document`.
 */
GlobalRegistrator.register({ url: 'http://localhost:4321/_emdash/admin/plugins/statusbeam/' })

/**
 * The real admin module, captured before any test file installs `mock.module`
 * for it. It is a plain copy because bun updates the module namespace in place on
 * `mock.module`. A test that needs the real `apiFetch` reads it from here, so it
 * does not depend on which test file ran first.
 */
// eslint-disable-next-line antfu/no-top-level-await -- the DOM must be registered before the admin module loads
;(globalThis as { __realEmdashAdmin?: unknown }).__realEmdashAdmin = { ...(await import('@emdash-cms/admin')) }
