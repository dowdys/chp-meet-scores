/**
 * User interaction tools — allows the agent to pause and ask the user questions.
 *
 * The actual IPC logic is injected via setAskUserHandler() from main.ts,
 * because tool executors don't have access to the BrowserWindow.
 */

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
    const question = args.question as string;
    const options = args.options as string[];

    if (!askUserHandler) {
      return 'Error: ask_user handler not configured. Cannot prompt user.';
    }

    if (!question || !options || options.length === 0) {
      return 'Error: ask_user requires a "question" string and an "options" array.';
    }

    const choice = await askUserHandler(question, options);
    return choice;
  },
};
