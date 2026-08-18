// The oldest supported LG webOS Chromium versions do not provide fetch or
// AbortController. These side-effect imports are harmless in modern browsers
// and keep the same app bundle usable on the TV production path.
import "abortcontroller-polyfill/dist/abortcontroller-polyfill-only.js";
import "whatwg-fetch";
