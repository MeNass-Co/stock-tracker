import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

export function useRealTime() {
  const [connected, setConnected] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    const events = new EventSource("/api/events");
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    events.onmessage = () => {
      void queryClient.invalidateQueries();
    };
    events.addEventListener("heartbeat", () => setConnected(true));
    return () => events.close();
  }, [queryClient]);

  return connected;
}
