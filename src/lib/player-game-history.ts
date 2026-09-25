import { cache } from "react";
import { fetchGamesForPlayers } from "./game-participants";

// Metadata and the page share the same indexed/fallback read within a render.
// No viewer state or long-lived result cache is involved.
export const getPlayerGameFacts = cache((userId: string) => fetchGamesForPlayers([userId]));
