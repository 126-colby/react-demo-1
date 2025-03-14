import type { LinksFunction as RRLinksFunction } from "react-router";

export namespace Route {
  export type LinksFunction = RRLinksFunction;
  
  export interface ErrorBoundaryProps {
    error: unknown;
  }
}
