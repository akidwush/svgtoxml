import { createConvertHandler } from '../lib/api-http.js';

// Endpoint khusus website resmi. Browser cross-origin diarahkan ke /api/v1/convert.
export default {
  fetch: createConvertHandler({ mode: 'public' })
};
