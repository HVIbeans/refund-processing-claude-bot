import { startServer } from './server.js';

const server = await startServer();
const { address, port } = server.address();
console.log(`Refund agent running at http://${address}:${port}`);
console.log(`Prompt coach feedback:  http://${address}:${port}/prompt-feedback`);
