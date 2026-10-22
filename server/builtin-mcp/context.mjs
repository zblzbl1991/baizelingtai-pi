import { AsyncLocalStorage } from 'node:async_hooks';
export const callContext = new AsyncLocalStorage();
export const currentSignal = () => callContext.getStore()?.signal ? [callContext.getStore().signal] : [];
