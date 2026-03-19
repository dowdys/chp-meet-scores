/**
 * User interaction tools — allows the agent to pause and ask the user questions.
 *
 * The actual IPC logic is injected via setAskUserHandler() from main.ts,
 * because tool executors don't have access to the BrowserWindow.
 */

import { requireString, requireArray } from './validation';

type AskUserHandler = (question: string, options: string[]) => Promise<string>;

let askUserHandler: AskUserHandler | null = null;

/**
 * Called from main.ts to inject the IPC bridge function.
 */
export function setAskUserHandler(handler: AskUserHandler): void {
  askUserHandler = handler;
}

export const userToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  ask_user: async (args) => {
    const question = requireString(args, 'question');
    const options = requireArray(args, 'options') as string[];

    if (!askUserHandler) {
      return 'Error: ask_user handler not configured. Cannot prompt user.';
    }

    if (options.length === 0) {
      return 'Error: ask_user requires at least one option.';
    }

    const choice = await askUserHandler(question, options);
    return choice;
  },
};
