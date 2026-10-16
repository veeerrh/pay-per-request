import type { Accept } from './payment-required';

/** Everything a rule may read. Rules are pure functions of this object (design 4.5). */
export interface ListingSnapshot {
  price: bigint;
  payTo: string;
  network: string;
  asset: string;
}

export interface Facts {
  /** Listing as it was when the task started (M-54). */
  listing: ListingSnapshot;
  /** Hash of the snapshot taken at task start, and hash of the live listing now. */
  snapshotHash: string;
  liveListingHash: string;
  accepts: Accept[];
  buyerAddress: string;
  config: { maxTimeoutSeconds: number; oddDropRatioPct: number };
}
