import { renderToReadableStream } from "react-dom/server.edge";
import { App } from "./App";

import clientAssets from "./entry-client?assets=client";
import serverAssets from "./entry-server?assets=ssr";

export default {
  async fetch(req: Request) {
    const url = new URL(req.url);
    const assets = clientAssets.merge(serverAssets);

    return new Response(
      await renderToReadableStream(
        <html lang="en">
          <head>
            <meta charSet="utf-8" />
            <meta
              name="viewport"
              content="width=device-width, initial-scale=1.0"
            />
            <title>Chat SDK Example</title>
            {assets.css.map((attr: Record<string, string>) => (
              <link key={attr.href} rel="stylesheet" {...attr} />
            ))}
            {assets.js.map((attr: Record<string, string>) => (
              <link key={attr.href} rel="modulepreload" {...attr} />
            ))}
            <script type="module" src={assets.entry} />
          </head>
          <body>
            <div id="app">
              <App pathname={url.pathname} />
            </div>
          </body>
        </html>,
      ),
      { headers: { "Content-Type": "text/html;charset=utf-8" } },
    );
  },
};
