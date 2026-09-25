import { useCallback, useEffect, useRef } from "react";
import { useGetAccount } from "@workspace/api-client-react";
import { ApiError } from "@workspace/api-client-react";

const BOT_BUILDER_PATH = "/bot/preview/";
const BOT_BUILDER_SYNC_MESSAGE = "NEUROTRADE_BOT_BUILDER_SYNC";
const BOT_BUILDER_READY_MESSAGE = "PREVIEW_READY";

export default function BotBuilder() {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const { data: account } = useGetAccount({
    query: {
      retry: (failureCount: number, error: unknown) => {
        const apiError = error as ApiError | null;
        if (apiError?.status === 404) return false;
        return failureCount < 1;
      },
    },
  } as { query: any });

  const postBuilderSync = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage(
      {
        type: BOT_BUILDER_SYNC_MESSAGE,
        source: "neurotrade-web",
        connected: Boolean(account?.loginId),
        loginId: account?.loginId ?? null,
      },
      window.location.origin,
    );
  }, [account?.loginId]);

  useEffect(() => {
    postBuilderSync();
  }, [postBuilderSync]);

  // The preview can finish booting after the iframe's load event. Re-send the
  // account hand-off when the builder explicitly announces that its listener is
  // ready, so a fast cache hit and a slow network load behave identically.
  useEffect(() => {
    const handleBuilderMessage = (event: MessageEvent<{ type?: string; source?: string }>) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== BOT_BUILDER_READY_MESSAGE) return;
      postBuilderSync();
    };

    window.addEventListener("message", handleBuilderMessage);
    return () => window.removeEventListener("message", handleBuilderMessage);
  }, [postBuilderSync]);

  return (
    <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col bg-background md:min-h-screen">
      <iframe
        ref={iframeRef}
        title="Deriv Bot Builder"
        src={BOT_BUILDER_PATH}
        className="min-h-0 flex-1 border-0 bg-white"
        allow="clipboard-read; clipboard-write; fullscreen"
        loading="eager"
        onLoad={postBuilderSync}
      />
    </div>
  );
}
