import { Type } from "typebox";

const model = {
  type: "chat",
  id: "fake",
  name: "H2 loopback",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768,
  maxTokens: 1024,
} as const;

export default function (pi: any) {
  const baseUrl = process.env.FACADE_H2_PI_URL ?? "";
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1") {
    throw new Error("The H2 extension needs its own HTTP loopback model.");
  }
  pi.registerProvider("h2", {
    baseUrl,
    apiKey: "loopback-test",
    api: "openai-completions",
    models: [model],
  });
  pi.registerTool({
    name: "h2_question",
    label: "H2 question",
    description: "Show the isolated fixture's two test choices in Pi.",
    parameters: Type.Object({
      question: Type.String(),
      header: Type.String(),
      options: Type.Array(Type.Object({ label: Type.String(), description: Type.String() })),
    }),
    async execute(_callId: string, args: { question: string; options: { label: string }[] }, _signal: unknown, _update: unknown, ctx: any) {
      const labels = args.options.map(option => option.label);
      if (!args.question.startsWith("Pick a value for H2Q_") || labels.join(",") !== "One,Two") {
        throw new Error("The test tool accepts only its fixture question.");
      }
      const answer = await ctx.ui.select(args.question, labels);
      return { content: [{ type: "text", text: answer ?? "Cancelled" }], details: {} };
    },
  });
}