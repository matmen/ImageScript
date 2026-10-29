// Vercel's Edge Runtime running the smoke test (a script handling fetch events)
import { smoke } from './smoke.mjs';

addEventListener('fetch', event => event.respondWith(smoke().then(results => Response.json(results))));
