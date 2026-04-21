declare namespace Express {
  interface Request {
    user?: {
      uid: string;
      email: string;
      role: string;
    };
    rawBody?: Buffer;
  }
}
