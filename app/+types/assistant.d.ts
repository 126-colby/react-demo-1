import type { LoaderFunctionArgs as RRLoaderFunctionArgs } from "react-router";

export namespace Route {
  export interface LoaderData {
    hassioUrl: string;
  }
  
  export interface LoaderArgs extends RRLoaderFunctionArgs {
    context: {
      cloudflare: {
        env: {
          HASSIO_URL: string;
          HASSIO_TOKEN: string;
          AI: any;
          DB: D1Database;
        };
        ctx: ExecutionContext;
      };
    };
  }
  
  export interface MetaArgs {
    data: LoaderData;
  }

  export interface ComponentProps {
    loaderData: LoaderData;
  }
}
