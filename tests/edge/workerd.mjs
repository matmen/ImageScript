// a Cloudflare Worker running the smoke test
import { smoke } from './smoke.mjs';

export default { fetch: async () => Response.json(await smoke()) };
