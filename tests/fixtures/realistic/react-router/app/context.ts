import { createContext } from 'react-router';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/** Set by requireUserMiddleware; reading it outside the dashboard throws. */
export const userContext = createContext<SessionUser>();
