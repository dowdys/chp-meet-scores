import { browserToolExecutors } from './browser-tools';
import { pythonToolExecutors } from './python-tools';
import { dbToolExecutors } from './db-tools';
import { searchToolExecutors } from './search-tools';
import { skillToolExecutors } from './skill-tools';

export const allToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  ...browserToolExecutors,
  ...pythonToolExecutors,
  ...dbToolExecutors,
  ...searchToolExecutors,
  ...skillToolExecutors,
};
