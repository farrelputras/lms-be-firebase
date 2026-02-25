export const success = <T>(data: T) => ({
  success: true as const,
  data,
});

export const error = (code: string, message: string) => ({
  success: false as const,
  error: {code, message},
});
