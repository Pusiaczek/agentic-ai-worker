import { afterAll } from 'vitest';
import { closeSharedDatabase } from './helpers/test-db.js';

// Runs before every test file. With TEST_DB_RESET=truncate the tests of a file share one
// database; close it when the file is done.
afterAll(closeSharedDatabase);
