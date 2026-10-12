/**
 * Developer tools (F1 overlay, cheat keys, visual lab, the `zm` console API) are available in `npm run dev`,
 * and in a published build only when the page is opened with `?debug` in the URL. Players never see them by accident.
 */
export const DEBUG_ENABLED = import.meta.env.DEV || new URLSearchParams(location.search).has('debug');
