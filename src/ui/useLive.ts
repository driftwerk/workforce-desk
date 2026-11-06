import { useEffect, useRef } from "react";

/** Whether the component is mounted now, for work that ends after it may
 *  have gone (a request, a timer). Set again on every mount: React's
 *  StrictMode mounts, unmounts and mounts again in development, and a flag
 *  only ever cleared on unmount stays cleared after that, so everything
 *  that checks it would be dropped for good (the machine sign-in that
 *  never left "Opening Claude's sign-in page…"). */
export function useLive(): { readonly current: boolean } {
  const live = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  return live;
}
