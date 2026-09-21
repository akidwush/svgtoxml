import { createConvertHandler } from '../../lib/api-http.js';

// Engine API untuk website/app lain. GET cocok untuk SVG kecil di query string,
// sedangkan POST direkomendasikan untuk SVG besar. API key tetap wajib.
export default {
  fetch: createConvertHandler({ mode: 'external' })
};
