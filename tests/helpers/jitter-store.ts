import type { Store } from "@/lib/store/types";

/** Wraps a store so each operation starts after a random 0 to 5 ms delay, as a network store would. */
export function jitter(store: Store, random: () => number = Math.random): Store {
  const wait = () => new Promise((r) => setTimeout(r, Math.floor(random() * 6)));
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        await wait();
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
