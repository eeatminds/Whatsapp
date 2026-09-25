import { createContext, useContext } from 'react';
import type { Me } from './api';

export const SessionContext = createContext<{ me: Me; reload: () => Promise<void> } | null>(null);

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession outside SessionContext');
  return value;
}

export function money(symbol: string, amount: number): string {
  return `${symbol}${amount.toLocaleString()}`;
}
