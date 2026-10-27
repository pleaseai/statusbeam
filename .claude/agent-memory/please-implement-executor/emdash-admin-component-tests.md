---
name: emdash-admin-component-tests
description: How packages/emdash-plugin React admin component tests run under bun (happy-dom preload, *.dom.tsx, mocking @emdash-cms/admin) and admin-bundle facts
metadata:
  type: project
---

Run: `bun run --cwd packages/emdash-plugin test:admin` (= `bun test --preload ./tests/dom-preload.ts ./tests/monitors.dom.tsx`). `*.dom.tsx` is ignored by plain `bun test`; list new files in the script. Pure editor-model tests (`admin-editor.test.ts`) need no DOM and run in the root suite.
- Preload registers `@happy-dom/global-registrator`; RTL `screen` works. Real `@emdash-cms/admin` imports fine under happy-dom (~3 s); spread it in `mock.module` and `await import` the component after.
- Kumo Input/Select render in happy-dom; a Select option needs pointerDown+pointerUp+mouseUp+click. Field errors are linked by `aria-describedby`.
- Admin locale = `<html lang>` (set by the admin LocaleDirectionProvider; cookie `emdash-locale` switches it). Settings page href: `/_emdash/admin/plugins-manager/<id>/settings`.
- `@statusbeam/core` resolves to `dist` types: run `bun run build` in packages/core after changing `Dict`, or typecheck fails.
- macOS: `sed -i ''` needs the empty suffix; `&&` after a failed sed skips the heredoc that follows.

**Why:** T005 setup cost. **How to apply:** T006/T007 component tests reuse tests/dom-preload.ts and the fake `apiFetch` pattern in tests/monitors.dom.tsx.
