const CHATBOT_DEFAULT_ACCESS = process.env.CHATBOT_DEFAULT_ACCESS === "true";

export function resolveChatbotEnabled(
  role: string | undefined,
  raw: unknown,
): boolean {
  if (role === "admin" || role === "instructor") return true;
  if (typeof raw === "boolean") return raw;
  return CHATBOT_DEFAULT_ACCESS;
}
