import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

const BOT_BUILDER_PATH = "/bot/preview/";

export default function BotBuilder() {
  return (
    <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col bg-background md:min-h-screen">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card/80 px-4 py-3 backdrop-blur md:px-6">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Deriv Bot Builder</h1>
          <p className="text-sm text-muted-foreground">
            Build, log in, and run Deriv bots in the original builder.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <a href={BOT_BUILDER_PATH} target="_blank" rel="noreferrer">
            <ExternalLink className="mr-2 h-4 w-4" />
            Open full screen
          </a>
        </Button>
      </div>

      <iframe
        title="Deriv Bot Builder"
        src={BOT_BUILDER_PATH}
        className="min-h-0 flex-1 border-0 bg-white"
        allow="clipboard-read; clipboard-write; fullscreen"
      />
    </div>
  );
}
