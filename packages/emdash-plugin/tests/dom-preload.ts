import { GlobalRegistrator } from '@happy-dom/global-registrator'

/**
 * Preload for the admin component tests (`*.dom.tsx`): a DOM for React to render
 * into. Registered process-wide, so those tests run in their own `bun test`
 * call (`test:admin`), apart from the plain tests that expect no `document`.
 */
GlobalRegistrator.register({ url: 'http://localhost:4321/_emdash/admin/plugins/statusbeam/' })
