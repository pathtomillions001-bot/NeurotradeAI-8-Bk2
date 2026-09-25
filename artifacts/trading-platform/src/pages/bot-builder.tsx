import { useCallback, useEffect, useRef } from "react";
import { useGetAccount } from "@workspace/api-client-react";
import { ApiError } from "@workspace/api-client-react";

const BOT_BUILDER_PATH = "/bot/preview/";
const BOT_BUILDER_SYNC_MESSAGE = "NEUROTRADE_BOT_BUILDER_SYNC";

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

  return (
    <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col bg-background md:min-h-screen">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card/80 px-4 py-3 backdrop-blur md:px-6">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Deriv Bot Builder</h1>
          <p className="text-sm text-muted-foreground">
            Build and run Deriv bots inside NeuroTrade with your connected account.
          </p>
        </div>
      </div>

      <iframe
        ref={iframeRef}
        title="Deriv Bot Builder"
        src={BOT_BUILDER_PATH}
        className="min-h-0 flex-1 border-0 bg-white"
        allow="clipboard-read; clipboard-write; fullscreen"
        onLoad={postBuilderSync}
      />
    </div>
  );
}
