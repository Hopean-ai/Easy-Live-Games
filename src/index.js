import { handleRequest } from './router.js';

export { PongRoom } from './room.js';
export { Accounts } from './accounts.js';
export { Matchmaker } from './matchmaker.js';
export { CfoRoom } from './cfo/room.js';
export { Ocean } from './driftmail/ocean.js';
export { Camp } from './legio/camp.js';
export { Office } from './career/office.js';

export default { fetch: handleRequest };
