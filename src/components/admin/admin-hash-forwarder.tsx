"use client";

import { useEffect } from "react";
import { adminForwardHref } from "@/lib/admin-tabs";

/**
 * Old one-page admin links still land: /admin used to hold every card, so
 * bookmarks, Discord messages (a medal-approval request links
 * /admin#adm-medal-approvals) and pages cached before the tabs point at
 * /admin#<card>. A hash never reaches the server, so Overview forwards it
 * here to the card's tab, keeping the query (a news or import page) and the
 * anchor. Overview's own cards and unknown anchors stay put.
 */
export function AdminHashForwarder() {
  useEffect(() => {
    const forward = () => {
      const target = adminForwardHref(window.location.search, window.location.hash);
      if (target) window.location.replace(target);
    };
    forward();
    window.addEventListener("hashchange", forward);
    return () => window.removeEventListener("hashchange", forward);
  }, []);
  return null;
}
