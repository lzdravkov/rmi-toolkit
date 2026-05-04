import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are the Revenue Management Intelligence (RMI) Toolkit assistant.
You help operators generate realistic demo transaction data for a Salesforce Revenue Cloud org (IEWC wire and cable distributor demo).

You guide the operator through three phases:
1. Account setup — determine whether to create new accounts or use existing ones, and how many.
2. Catalog selection — choose which product catalog(s) to use.
3. Order generation — determine how many orders per account.

Be concise and direct. Ask one question at a time. Confirm choices before executing.
When you have all the information needed to proceed to the next phase, summarize what you'll do and ask for confirmation.

You will be given structured context messages (prefixed with [SYSTEM]) that describe org state (available catalogs, existing accounts, etc.). Use this context to inform your responses.

Never invent product names, catalog names, or account IDs — always reference what was provided in context.`;

export class Agent {
  constructor() {
    this.history = [];
  }

  /**
   * Send a message to Claude and get a response.
   * Returns the assistant's reply text.
   */
  async chat(userMessage) {
    this.history.push({ role: 'user', content: userMessage });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: this.history,
    });

    const assistantText = response.content[0].text;
    this.history.push({ role: 'assistant', content: assistantText });
    return assistantText;
  }

  /**
   * Inject a system-level context message (not shown as user input).
   * Used to feed org data (catalogs, accounts) into the conversation.
   */
  injectContext(contextText) {
    this.history.push({ role: 'user', content: `[SYSTEM] ${contextText}` });
    this.history.push({ role: 'assistant', content: 'Understood. I have the context.' });
  }
}
