import * as vscode from 'vscode';
import { CommentData } from './model';
import { PanelRequest, parsePanelRequest } from './panelProtocol';

export interface PanelState {
  file: string | null;
  showResolved: boolean;
  comments: CommentData[];
}

export class WebviewSurface implements vscode.WebviewViewProvider {
  static readonly viewId = 'commentTrackerReviewPanel';

  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly loadState: () => PanelState,
    private readonly onRequest: (request: PanelRequest) => void | Promise<void>
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(
      message => {
        const request = parsePanelRequest(message);
        if (request) {
          void Promise.resolve(this.onRequest(request)).catch(error => {
            const detail = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Comment action failed: ${detail}`);
          });
        }
      },
      undefined,
      []
    );
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.pushState();
      }
    }, undefined, []);
    this.pushState();
  }

  highlight(commentId: string | null, scroll = true): void {
    this.post({ type: 'highlight', commentId, scroll });
  }

  /** Scrolls the panel proportionally to the document position (0..1). */
  anchor(fraction: number): void {
    this.post({ type: 'anchor', fraction });
  }

  dispose(): void {
    this.view = undefined;
  }

  pushState(): void {
    const state = this.loadState();
    this.post({ type: 'state', ...state });
  }

  private post(message: Record<string, unknown>): void {
    void this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const nonce = Array.from({ length: 16 }, () =>
      Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
    ).join('');
    const style = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'review.css')
    );
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'review.js')
    );
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}">
<title>Review Comments</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

