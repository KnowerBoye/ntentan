


// to make the file a module and avoid the TypeScript error
export {}

declare global {
  namespace Express {
      export interface Request {
        
        validated?: {
        body?: unknown
        query?: unknown
        params?: unknown
        },

        user?: {
          uid: string;
          email: string | null;
          name: string | null;
          picture: string | null;
        },
        // sessionId : string 
  }
  }
}
