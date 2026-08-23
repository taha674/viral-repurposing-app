import type { Reel, Analysis } from "@/lib/types";

// Shared prop contract every stages/*.tsx body component receives from
// StageModal — a single fetched Reel (the full row, unlike the board's
// trimmed ReelSummary), busy/err state lifted to the modal so multiple
// buttons in one stage can share one in-flight indicator, and callbacks to
// refetch this reel and to tell the board to refetch its list.
export interface StageProps {
  reel: Reel;
  analysis: Analysis | null;
  busy: string;
  setBusy: (b: string) => void;
  err: string;
  setErr: (e: string) => void;
  reload: () => Promise<void>;
  onBoardChange: () => void;
  onClose: () => void;
}
