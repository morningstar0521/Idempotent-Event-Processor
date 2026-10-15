import { config } from '../shared/config.js';
import { startServer } from '../api/server.js';

startServer(config.PORT);

