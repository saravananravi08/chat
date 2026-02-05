import { createRedisState } from "@chat-adapter/state-redis";
import { ToolLoopAgent } from "ai";
import {
  Actions,
  Button,
  Card,
  CardText,
  Chat,
  ConsoleLogger,
  Divider,
  emoji,
  Field,
  Fields,
  LinkButton,
  Modal,
  Section,
  Select,
  SelectOption,
  TextInput,
} from "chat";
import { buildAdapters } from "./adapters";

const state = createRedisState({
  url: process.env.REDIS_URL || "",
  keyPrefix: "chat-sdk-webhooks",
  logger: new ConsoleLogger("debug"),
});
const adapters = buildAdapters();

interface ThreadState {
  aiMode?: boolean;
}

export const bot = new Chat<typeof adapters, ThreadState>({
  userName: process.env.BOT_USERNAME || "mybot",
  adapters,
  state,
  logger: "debug",
});

const agent = new ToolLoopAgent({
  model: "anthropic/claude-3.5-haiku",
  instructions:
    "You are a helpful assistant in a chat thread. Answer the user's queries in a concise manner.",
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();

  if (/\bAI\b/i.test(message.text)) {
    await thread.setState({ aiMode: true });
    await thread.post(
      Card({
        title: `${emoji.sparkles} AI Mode Enabled`,
        children: [
          CardText(
            "I'm now in AI mode! I'll use Claude to respond to your messages in this thread.",
          ),
          CardText('Say "disable AI" to turn off AI mode.'),
          Divider(),
          Fields([
            Field({ label: "Platform", value: thread.adapter.name }),
            Field({ label: "Mode", value: "AI Assistant" }),
          ]),
        ],
      }),
    );

    const result = await agent.stream({ prompt: message.text });
    await thread.post(result.textStream);
    return undefined;
  }

  await thread.startTyping();
  await thread.post(
    Card({
      title: `${emoji.wave} Welcome!`,
      subtitle: `Connected via ${thread.adapter.name}`,
      children: [
        CardText("I'm now listening to this thread. Try these actions:"),
        CardText(
          `${emoji.sparkles} **Mention me with "AI"** to enable AI assistant mode`,
        ),
        Divider(),
        Fields([
          Field({ label: "DM Support", value: thread.isDM ? "Yes" : "No" }),
          Field({ label: "Platform", value: thread.adapter.name }),
        ]),
        Divider(),
        Actions([
          Button({ id: "hello", label: "Say Hello", style: "primary" }),
          Button({ id: "ephemeral", label: "Ephemeral response" }),
          Button({ id: "info", label: "Show Info" }),
          Button({ id: "feedback", label: "Send Feedback" }),
          Button({ id: "messages", label: "Fetch Messages" }),
          LinkButton({ url: "https://vercel.com", label: "Open Link" }),
          Button({ id: "goodbye", label: "Goodbye", style: "danger" }),
        ]),
      ],
    }),
  );
});

bot.onAction("ephemeral", async (event) => {
  await event.thread.postEphemeral(
    event.user,
    "This is an ephemeral response!",
    { fallbackToDM: true },
  );
});

bot.onAction("hello", async (event) => {
  await event.thread.post(`${emoji.wave} Hello, ${event.user.fullName}!`);
});

bot.onAction("info", async (event) => {
  const threadState = (await event.thread.state) as ThreadState | null;
  await event.thread.post(
    Card({
      title: "Bot Information",
      children: [
        Fields([
          Field({ label: "User", value: event.user.fullName }),
          Field({ label: "User ID", value: event.user.userId }),
          Field({ label: "Platform", value: event.adapter.name }),
          Field({ label: "Thread ID", value: event.threadId }),
          Field({
            label: "AI Mode",
            value: threadState?.aiMode ? "Enabled" : "Disabled",
          }),
        ]),
      ],
    }),
  );
});

bot.onAction("goodbye", async (event) => {
  await event.thread.post(
    `${emoji.wave} Goodbye, ${event.user.fullName}! See you later.`,
  );
});

// Open feedback modal
bot.onAction("feedback", async (event) => {
  await event.openModal(
    Modal({
      callbackId: "feedback_form",
      title: "Send Feedback",
      submitLabel: "Send",
      closeLabel: "Cancel",
      notifyOnClose: true,
      children: [
        TextInput({
          id: "message",
          label: "Your Feedback",
          placeholder: "Tell us what you think...",
          multiline: true,
        }),
        Select({
          id: "category",
          label: "Category",
          placeholder: "Select a category",
          options: [
            SelectOption({ label: "Bug Report", value: "bug" }),
            SelectOption({ label: "Feature Request", value: "feature" }),
            SelectOption({ label: "General Feedback", value: "general" }),
            SelectOption({ label: "Other", value: "other" }),
          ],
        }),
        TextInput({
          id: "email",
          label: "Email (optional)",
          placeholder: "your@email.com",
          optional: true,
        }),
      ],
    }),
  );
});

// Handle modal submission
bot.onModalSubmit("feedback_form", async (event) => {
  const { message, category, email } = event.values;

  // Validate message
  if (!message || message.length < 5) {
    return {
      action: "errors" as const,
      errors: { message: "Feedback must be at least 5 characters" },
    };
  }

  // Log the feedback
  console.log("Received feedback:", {
    message,
    category,
    email,
    user: event.user.userName,
  });
  await event.relatedMessage?.edit(`${emoji.check} **Feedback received!**`);
  await event.relatedThread?.post(
    Card({
      title: `${emoji.check} Feedback received!`,
      children: [
        CardText("Thank you for your feedback!"),
        Fields([
          Field({ label: "User", value: event.user.fullName }),
          Field({ label: "Category", value: category ?? "" }),
          Field({ label: "Message", value: message ?? "" }),
          Field({ label: "Email", value: email ?? "" }),
        ]),
      ],
    }),
  );

  return undefined;
});

// Handle modal close (cancel)
bot.onModalClose("feedback_form", async (event) => {
  console.log(`${event.user.userName} cancelled the feedback form`);
});

bot.onAction("messages", async (event) => {
  const { thread } = event;

  const getDisplayText = (text: string, hasAttachments?: boolean) => {
    if (text?.trim()) {
      const truncated = text.slice(0, 30);
      return text.length > 30 ? `${truncated}...` : truncated;
    }
    return hasAttachments ? "[Attachment]" : "[Card]";
  };

  try {
    const recentResult = await thread.adapter.fetchMessages(thread.id, {
      limit: 5,
      direction: "backward",
    });

    const oldestResult = await thread.adapter.fetchMessages(thread.id, {
      limit: 5,
      direction: "forward",
    });

    const allMessages: string[] = [];
    let count = 0;
    for await (const msg of thread.allMessages) {
      const displayText = getDisplayText(
        msg.text,
        msg.attachments && msg.attachments.length > 0,
      );
      allMessages.push(
        `Msg ${count + 1}: ${msg.author.userName} - ${displayText}`,
      );
      count++;
    }

    const formatMessages = (msgs: typeof recentResult.messages) =>
      msgs.length > 0
        ? msgs
            .map((m, i) => {
              const displayText = getDisplayText(
                m.text,
                m.attachments && m.attachments.length > 0,
              );
              return `Msg ${i + 1}: ${m.author.userName} - ${displayText}`;
            })
            .join("\n\n")
        : "(no messages)";

    await thread.post(
      Card({
        title: `${emoji.memo} Message Fetch Results`,
        children: [
          Section([
            CardText("**fetchMessages (backward, limit: 5)**"),
            CardText("Gets most recent messages, cursor points to older"),
            CardText(formatMessages(recentResult.messages)),
            CardText(
              `Next cursor: ${recentResult.nextCursor ? "yes" : "none"}`,
            ),
          ]),
          Divider(),
          Section([
            CardText("**fetchMessages (forward, limit: 5)**"),
            CardText("Gets oldest messages first, cursor points to newer"),
            CardText(formatMessages(oldestResult.messages)),
            CardText(
              `Next cursor: ${oldestResult.nextCursor ? "yes" : "none"}`,
            ),
          ]),
          Divider(),
          Section([
            CardText("**allMessages iterator**"),
            CardText("Iterates from oldest to newest using forward direction"),
            CardText(
              allMessages.length > 0
                ? allMessages.join("\n\n")
                : "(no messages)",
            ),
          ]),
        ],
      }),
    );
  } catch (err) {
    await thread.post(
      `${emoji.warning} Error fetching messages: ${
        err instanceof Error ? err.message : "Unknown error"
      }`,
    );
  }
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

bot.onNewMessage(/help/i, async (thread, message) => {
  const platforms = Object.keys(adapters).join(", ") || "none configured";
  await thread.post(
    Card({
      title: `${emoji.question} Help`,
      children: [
        CardText(`Hi ${message.author.userName}! Here's how I can help:`),
        Divider(),
        Section([
          CardText(`${emoji.star} **Mention me** to start a conversation`),
          CardText(
            `${emoji.sparkles} **Mention me with "AI"** to enable AI assistant mode`,
          ),
          CardText(
            `${emoji.eyes} I'll respond to messages in threads where I'm mentioned`,
          ),
          CardText(`${emoji.fire} React to my messages and I'll react back!`),
          CardText(`${emoji.rocket} Active platforms: ${platforms}`),
        ]),
      ],
    }),
  );
});

bot.onSubscribedMessage(async (thread, message) => {
  const threadState = await thread.state;

  if (/disable\s*AI/i.test(message.text)) {
    await thread.setState({ aiMode: false });
    await thread.post(`${emoji.check} AI mode disabled for this thread.`);
    return;
  }

  if (/enable\s*AI/i.test(message.text)) {
    await thread.setState({ aiMode: true });
    await thread.post(`${emoji.sparkles} AI mode enabled for this thread!`);
    return;
  }

  if (threadState?.aiMode) {
    let messages: typeof thread.recentMessages;
    try {
      const result = await thread.adapter.fetchMessages(thread.id, {
        limit: 20,
      });
      messages = result.messages;
    } catch {
      messages = thread.recentMessages;
    }
    const history = [...messages]
      .reverse()
      .filter((msg) => msg.text.trim())
      .map((msg) => ({
        role: msg.author.isMe ? ("assistant" as const) : ("user" as const),
        content: msg.text,
      }));
    console.log("history", history);
    const result = await agent.stream({ prompt: history });
    await thread.post(result.textStream);
    return;
  }

  if (/^dm\s*me$/i.test(message.text.trim())) {
    try {
      const dmThread = await bot.openDM(message.author);
      await dmThread.post(
        Card({
          title: `${emoji.speech_bubble} Private Message`,
          children: [
            CardText(
              `Hi ${message.author.fullName}! You requested a DM from the thread.`,
            ),
            Divider(),
            CardText("This is a private conversation between us."),
          ],
        }),
      );
      await thread.post(`${emoji.check} I've sent you a DM!`);
    } catch (err) {
      await thread.post(
        `${emoji.warning} Sorry, I couldn't send you a DM. Error: ${
          err instanceof Error ? err.message : "Unknown error"
        }`,
      );
    }
    return;
  }

  if (message.attachments && message.attachments.length > 0) {
    const attachmentInfo = message.attachments
      .map(
        (a) =>
          `- ${a.name || "unnamed"} (${a.type}, ${a.mimeType || "unknown"})`,
      )
      .join("\n");

    await thread.post(
      Card({
        title: `${emoji.eyes} Attachments Received`,
        children: [
          CardText(`You sent ${message.attachments.length} file(s):`),
          CardText(attachmentInfo),
        ],
      }),
    );
    return;
  }

  await thread.startTyping();
  await delay(1000);
  const response = await thread.post(`${emoji.thinking} Processing...`);
  await delay(2000);
  await response.edit(`${emoji.eyes} Just a little bit...`);
  await delay(1000);
  await response.edit(`${emoji.check} Thanks for your message!`);
});

bot.onReaction(["thumbs_up", "heart", "fire", "rocket"], async (event) => {
  if (!event.added) return;

  if (event.adapter.name === "gchat" || event.adapter.name === "teams") {
    await event.adapter.postMessage(
      event.threadId,
      `Thanks for the ${event.rawEmoji}!`,
    );
    return;
  }

  await event.adapter.addReaction(
    event.threadId,
    event.messageId,
    emoji.raised_hands,
  );
});
