import { createConvertHandler } from '../../lib/api-http.js';

// Engine API untuk website/app lain. Selalu membutuhkan API key yang dikonfigurasi owner.
export default {
  fetch: createConvertHandler({ mode: 'external' })
};
