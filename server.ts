import express from "express";
import http from "http";
import path from "path";
import { WebSocketServer } from "ws";
import { GoogleGenAI, Modality, Type, LiveServerMessage } from "@google/genai";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { 
  loadMemories, 
  saveMemories, 
  formatSystemInstructionsWithMemories, 
  processConversationSlice 
} from "./server_memory";
import { Memory } from "./src/lib/memoryTypes";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;
  
  app.use(express.json());

  // Memory REST API Endpoints
  app.get("/api/memories", async (req, res) => {
    try {
      const memories = await loadMemories();
      res.json(memories);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/memories", async (req, res) => {
    try {
      const { category, text } = req.body;
      if (!category || !text) {
        return res.status(400).json({ error: "Category and text parameters are required." });
      }
      const memories = await loadMemories();
      const timestamp = new Date().toISOString();
      const newMemory: Memory = {
        id: Math.random().toString(36).substring(2, 11),
        category,
        text,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      memories.push(newMemory);
      await saveMemories(memories);
      res.status(201).json(newMemory);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/memories/:id", async (req, res) => {
    try {
      const { id } = req.params;
      let memories = await loadMemories();
      memories = memories.filter(m => m.id !== id);
      await saveMemories(memories);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Safe Server-Side Scraper & HTML Proxy endpoint
  app.get("/api/proxy", async (req, res) => {
    try {
      const url = req.query.url as string;
      if (!url) {
        return res.status(400).json({ error: "Missing 'url' parameter." });
      }

      console.log(`[Proxy Scraper] Fetching external content for: ${url}`);
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
        }
      });

      if (!response.ok) {
        throw new Error(`Scraper failed to load page: status ${response.status}`);
      }

      const html = await response.text();

      // Simple regex-based HTML parsers for standard items
      const titleMatch = html.match(/<title>(.*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : "";

      // Extract high-level headings (h1, h2, h3)
      const headings: string[] = [];
      const headingMatches = html.matchAll(/<h([1-3])\b[^>]*>(.*?)<\/h\1>/gi);
      for (const match of headingMatches) {
        const text = match[2].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 3 && text.length < 120 && !headings.includes(text)) {
          headings.push(text);
        }
      }

      // Extract organic anchor links
      const links: { text: string; href: string }[] = [];
      const linkMatches = html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi);
      for (const match of linkMatches) {
        let href = match[1].trim();
        const text = match[2].replace(/<[^>]*>/g, "").trim();
        
        if (text && text.length > 2 && text.length < 100) {
          if (href.startsWith("/")) {
            try {
              const u = new URL(url);
              href = `${u.protocol}//${u.host}${href}`;
            } catch {}
          }
          if (href.startsWith("http://") || href.startsWith("https://")) {
            links.push({ text, href });
          }
        }
      }

      // Extract general copy paragraphs
      const paragraphs: string[] = [];
      const paragraphMatches = html.matchAll(/<p\b[^>]*>(.*?)<\/p>/gi);
      for (const match of paragraphMatches) {
        const text = match[1].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 25 && text.length < 600 && !paragraphs.includes(text)) {
          paragraphs.push(text);
        }
      }

      // Extract button elements
      const buttons: string[] = [];
      const buttonMatches = html.matchAll(/<button\b[^>]*>(.*?)<\/button>/gi);
      for (const match of buttonMatches) {
        const text = match[1].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 1 && text.length < 60 && !buttons.includes(text)) {
          buttons.push(text);
        }
      }

      res.json({
        url,
        title,
        headings: headings.slice(0, 15),
        links: links.filter(l => !l.href.includes("javascript:")).slice(0, 30),
        buttons: buttons.slice(0, 15),
        paragraphs: paragraphs.slice(0, 12)
      });

    } catch (err: any) {
      console.error(`[Proxy Scraper] Error fetching ${req.query.url}:`, err.message);
      res.status(500).json({ error: `Scraper error: ${err.message}` });
    }
  });

  // High-fidelity fully functional HTML Proxy which circumvents CSP and X-Frame-Options
  app.get("/api/web-proxy", async (req, res) => {
    let targetUrl = "";
    try {
      const urlParam = req.query.url as string;
      if (!urlParam) {
        return res.status(400).send("Myraa Web Proxy Error: Missing target 'url' parameter");
      }

      targetUrl = urlParam.trim();
      
      // Prevent relative paths from requesting on same-origin
      if (targetUrl.startsWith("/")) {
        return res.status(400).send(`Myraa Web Proxy Error: Relative paths are not supported directly (${targetUrl}).`);
      }

      // Check protocol and hostname format
      try {
        if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
          targetUrl = "https://" + targetUrl;
        }
        const parsed = new URL(targetUrl);
        if (!parsed.hostname || !parsed.hostname.includes(".")) {
          throw new Error("Missing or invalid domain name extension (e.g. .com, .org, .net).");
        }
      } catch (err: any) {
        return res.status(400).send(`Myraa Web Proxy Error: Invalid URL specified: "${urlParam}". Make sure you enter a valid domain name.`);
      }

      console.log(`[Web Proxy] Routing connection through proxy: ${targetUrl}`);
      
      let response;
      try {
        response = await fetch(targetUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"
          }
        });
      } catch (fetchErr: any) {
        console.warn(`[Web Proxy Failed Fetch] Target: ${targetUrl} Error:`, fetchErr.message);
        return res.status(502).send(`Myraa Web Proxy Error: Unable to fetch the website "${targetUrl}". The site might be offline, or the URL address is spelled incorrectly. Details: ${fetchErr.message}`);
      }

      if (!response.ok) {
        return res.status(response.status).send(`Myraa Web Proxy Error: Failed loading remote website. Server returned status: ${response.status} (${response.statusText})`);
      }

      const contentType = response.headers.get("content-type") || "";
      
      // If it is not HTML (e.g. stylesheet, script, or image loaded directly), proxy it as binary
      if (!contentType.includes("text/html")) {
        const arrayBuffer = await response.arrayBuffer();
        res.setHeader("Content-Type", contentType);
        return res.send(Buffer.from(arrayBuffer));
      }

      let htmlContents = await response.text();

      // Inject base tag to resolve relative paths and direct parent communication scripts
      const baseUrlTag = `<base href="${targetUrl}" />`;
      const interceptorScript = `
        <script>
          (function() {
            // Hijack link interactions safely
            document.addEventListener('click', function(e) {
              var anchor = e.target.closest('a');
              if (anchor) {
                var href = anchor.getAttribute('href');
                if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
                  e.preventDefault();
                  try {
                    var resolvedUrl = new URL(href, window.location.href).href;
                    window.parent.postMessage({ type: 'NAVIGATE', url: resolvedUrl }, '*');
                  } catch (err) {
                    console.error("[Proxy Interceptor] Failed resolving link:", err);
                  }
                }
              }
            }, true);

            // Hijack search form submits
            document.addEventListener('submit', function(e) {
              var form = e.target;
              if (form) {
                e.preventDefault();
                try {
                  var formData = new FormData(form);
                  var params = new URLSearchParams();
                  formData.forEach(function(value, key) {
                    if (typeof value === 'string') {
                      params.append(key, value);
                    }
                  });
                  var actionAttr = form.getAttribute('action') || '';
                  var actionUrl = new URL(actionAttr, window.location.href).href;
                  if (form.method.toLowerCase() === 'get') {
                    actionUrl += (actionUrl.indexOf('?') !== -1 ? '&' : '?') + params.toString();
                  }
                  window.parent.postMessage({ type: 'NAVIGATE', url: actionUrl }, '*');
                } catch (err) {
                  console.error("[Proxy Interceptor] Failed submitting form:", err);
                }
              }
            }, true);

            // Neutralize parent context locks (frame-busters)
            window.alert = function(msg) { console.log("[Myraa Browser alert bypassed]:", msg); };
            window.confirm = function(msg) { console.log("[Myraa Browser confirm bypassed]:", msg); return true; };
            window.open = function(url) { window.parent.postMessage({ type: 'NAVIGATE', url: url }, '*'); return null; };
          })();
        </script>
      `;

      // Inject into <head> or prepend
      if (htmlContents.includes("<head>")) {
        htmlContents = htmlContents.replace("<head>", `<head>\n${baseUrlTag}\n${interceptorScript}`);
      } else if (htmlContents.includes("<HEAD>")) {
        htmlContents = htmlContents.replace("<HEAD>", `<HEAD>\n${baseUrlTag}\n${interceptorScript}`);
      } else {
        htmlContents = baseUrlTag + "\n" + interceptorScript + "\n" + htmlContents;
      }

      // Neutralize security headers to allow displaying in an iframe on same-origin
      res.setHeader("Content-Type", "text/html");
      res.setHeader("X-Myraa-Proxied", "true");
      res.removeHeader("X-Frame-Options");
      res.removeHeader("Content-Security-Policy");
      res.removeHeader("content-security-policy");
      res.removeHeader("x-frame-options");
      
      res.status(200).send(htmlContents);
    } catch (e: any) {
      console.warn("[Web Proxy Exception] Handled internal error:", e.message);
      res.status(500).send(`Myraa Web Proxy Error: Internal error occurred proxying URL "${targetUrl || "unknown"}". Details: ${e.message}`);
    }
  });

  // Real-time live YouTube search proxy endpoint
  app.get("/api/youtube-search", async (req, res) => {
    try {
      const query = req.query.q as string;
      if (!query) {
        return res.status(400).json({ error: "Missing query q" });
      }

      console.log(`[YouTube Proxy Search] Searching real YouTube for: "${query}"`);
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en&sp=EgIQAQ%253D%253D`;
      const response = await fetch(searchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
        }
      });
      const html = await response.text();

      const videoList: any[] = [];
      
      // Look for the start of `ytInitialData = ` or variation
      let jsonStartIdx = html.indexOf("ytInitialData = ");
      if (jsonStartIdx === -1) jsonStartIdx = html.indexOf("ytInitialData=");
      if (jsonStartIdx === -1) jsonStartIdx = html.indexOf('window["ytInitialData"] = ');
      if (jsonStartIdx === -1) jsonStartIdx = html.indexOf("window['ytInitialData'] = ");

      if (jsonStartIdx !== -1) {
        const startOfObj = html.indexOf("{", jsonStartIdx);
        if (startOfObj !== -1) {
          let braceCount = 0;
          let endOfObj = -1;
          for (let i = startOfObj; i < html.length; i++) {
            if (html[i] === "{") {
              braceCount++;
            } else if (html[i] === "}") {
              braceCount--;
              if (braceCount === 0) {
                endOfObj = i;
                break;
              }
            }
          }
          if (endOfObj !== -1) {
            const potentialJsonStr = html.substring(startOfObj, endOfObj + 1);
            try {
              const data = JSON.parse(potentialJsonStr);
              // Traverse standard YouTube search result contents
              const contents = data.contents?.twoColumnSearchResultRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents;
              if (contents && Array.isArray(contents)) {
                for (const item of contents) {
                  if (item.videoRenderer) {
                    const vr = item.videoRenderer;
                    const vId = vr.videoId;
                    if (vId) {
                      videoList.push({
                        videoId: vId,
                        title: vr.title?.runs?.[0]?.text || vr.title?.simpleText || "YouTube Video",
                        thumbnail: `https://i.ytimg.com/vi/${vId}/hqdefault.jpg`,
                        author: vr.ownerText?.runs?.[0]?.text || vr.shortBylineText?.runs?.[0]?.text || "Unknown Channel",
                        duration: vr.lengthText?.simpleText || "N/A",
                        views: vr.viewCountText?.simpleText || "N/A",
                        published: vr.publishedTimeText?.simpleText || ""
                      });
                    }
                  }
                }
              }
              console.log(`[YouTube Parser Engine] Robust balanced brace extraction succeeded. Found ${videoList.length} videos.`);
            } catch (e: any) {
              console.error("[YouTube Parser Engine] Balanced brace JSON parse error:", e.message);
            }
          }
        }
      }

      // Regex fallback if JSON extraction gets blocked or is empty
      if (videoList.length === 0) {
        const videoRendererRegex = /"videoRenderer":\s*\{/g;
        let match;
        const seenIds = new Set<string>();
        
        while ((match = videoRendererRegex.exec(html)) !== null && videoList.length < 15) {
          const startIdx = match.index;
          // Extract a safe chunk of text following the "videoRenderer": { key
          const chunk = html.substring(startIdx, startIdx + 3000);
          
          const idMatch = chunk.match(/"videoId"\s*:\s*"([^"]{11})"/);
          if (idMatch) {
            const vId = idMatch[1];
            if (!seenIds.has(vId)) {
              seenIds.add(vId);
              
              // Extract Title
              let title = "YouTube Video";
              const titleRunsMatch = chunk.match(/"title"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"([^"]+)"/);
              if (titleRunsMatch) {
                title = titleRunsMatch[1];
              } else {
                const titleSimpleMatch = chunk.match(/"title"\s*:\s*\{\s*"simpleText"\s*:\s*"([^"]+)"/);
                if (titleSimpleMatch) {
                  title = titleSimpleMatch[1];
                }
              }
              // Decode basic Unicode sequence codes
              title = title.replace(/\\u([0-9a-fA-F]{4})/g, (_, p1) => String.fromCharCode(parseInt(p1, 16)));
              // Replace double quote string escaping
              title = title.replace(/\\"/g, '"');
              
              // Extract Author/Channel
              let author = "YouTube Creator";
              const ownerMatch = chunk.match(/"ownerText"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"([^"]+)"/);
              if (ownerMatch) {
                author = ownerMatch[1];
              } else {
                const bylineMatch = chunk.match(/"shortBylineText"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"([^"]+)"/);
                if (bylineMatch) {
                  author = bylineMatch[1];
                }
              }
              author = author.replace(/\\u([0-9a-fA-F]{4})/g, (_, p1) => String.fromCharCode(parseInt(p1, 16)));
              author = author.replace(/\\"/g, '"');

              // Extract Duration
              let duration = "N/A";
              const lengthMatch = chunk.match(/"lengthText"\s*:\s*\{\s*"simpleText"\s*:\s*"([^"]+)"/);
              if (lengthMatch) {
                duration = lengthMatch[1];
              }

              // Extract Views
              let views = "N/A";
              const viewsMatch = chunk.match(/"viewCountText"\s*:\s*\{\s*"simpleText"\s*:\s*"([^"]+)"/);
              if (viewsMatch) {
                views = viewsMatch[1];
              } else {
                const shortViewsMatch = chunk.match(/"shortViewCountText"\s*:\s*\{\s*"simpleText"\s*:\s*"([^"]+)"/);
                if (shortViewsMatch) {
                  views = shortViewsMatch[1];
                }
              }

              videoList.push({
                videoId: vId,
                title,
                thumbnail: `https://i.ytimg.com/vi/${vId}/hqdefault.jpg`,
                author,
                duration,
                views,
                published: "Active Video"
              });
            }
          }
        }
      }

      res.setHeader("Cache-Control", "public, max-age=60");
      res.status(200).json({ results: videoList.slice(0, 15) });
    } catch (err: any) {
      console.error("[YouTube Search Error]:", err.message);
      res.status(500).json({ error: err.message, results: [] });
    }
  });

  // Real-time live general web search proxy endpoint (HTML DuckDuckGo Scraper OR Gemini Search Grounding)
  app.get("/api/web-search", async (req, res) => {
    try {
      const query = req.query.q as string;
      if (!query) {
        return res.status(400).json({ status: "error", error: "Missing query q" });
      }

      console.log(`[Web Proxy Search] Searching real-time indexes for: "${query}"`);

      const apiKey = process.env.GEMINI_API_KEY;
      if (apiKey) {
        try {
          console.log("[Web Search] Attempting Gemini Google Search Grounding...");
          const aiInstance = new GoogleGenAI({
            apiKey: apiKey,
            httpOptions: {
              headers: {
                'User-Agent': 'aistudio-build',
              }
            }
          });

          // Instruct Gemini to perform search grounding and return JSON format
          const prompt = `Perform a high-fidelity Google Search for: "${query}". Return the top 10 relevant search results.
You must return your output strictly in JSON format matching the following schema. Keep snippets informative and concise (under 160 characters).
Do not wrap your response in markdown code wrappers (like \`\`\`json). Return raw JSON only.

JSON Schema:
{
  "results": [
    {
      "title": "title of web page",
      "url": "full URL link",
      "snippet": "short descriptive snippet of content or page summary"
    }
  ]
}`;

          const completion = await aiInstance.models.generateContent({
            model: "gemini-3.5-flash",
            contents: prompt,
            config: {
              tools: [{ googleSearch: {} }]
            }
          });

          let results: any[] = [];
          const textCandidate = completion.text || "";
          
          try {
            let jsonText = textCandidate.trim();
            // Clean markdown block wrapper if model has wrapped it
            if (jsonText.startsWith("```")) {
              const startIdx = jsonText.indexOf("{");
              const endIdx = jsonText.lastIndexOf("}");
              if (startIdx !== -1 && endIdx !== -1) {
                jsonText = jsonText.substring(startIdx, endIdx + 1);
              }
            }
            const parsed = JSON.parse(jsonText);
            if (parsed && Array.isArray(parsed.results)) {
              results = parsed.results;
            }
          } catch (jsonErr: any) {
            console.log("[Web Search] JSON parsing failed, using Grounding Chunks metadata directly...", jsonErr.message);
          }

          // Fallback / verification from grounding chunks
          const chunks = completion.candidates?.[0]?.groundingMetadata?.groundingChunks;
          if ((!results || results.length === 0) && chunks && Array.isArray(chunks)) {
            console.log("[Web Search] Building clean structured list from Google organic Search grounding indexes...");
            for (const chunk of chunks) {
              if (chunk.web && chunk.web.uri) {
                results.push({
                  title: chunk.web.title || "Organic Web Match",
                  url: chunk.web.uri,
                  snippet: `Trustworthy web reference matching inquiry: "${query}"`
                });
              }
            }
          }

          if (results && results.length > 0) {
            console.log(`[Web Search] Successfully retrieved ${results.length} Google-grounded records.`);
            res.setHeader("Cache-Control", "public, max-age=120");
            return res.json({ results });
          }
        } catch (error: any) {
          console.warn("[Web Search Gemini Warning, falling back to scraper]:", error.message);
        }
      }

      // Fallback: Scraping html.duckduckgo.com
      console.log("[Web Search] Falling back to Direct DuckDuckGo HTML Scraper...");
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const response = await fetch(searchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9"
        }
      });
      const html = await response.text();

      const results: any[] = [];
      const blocks = html.split('class="result results_links');
      
      // Skip the first block because it's everything before the first result
      for (let i = 1; i < blocks.length && results.length < 15; i++) {
        const block = blocks[i];
        
        // Extract URL
        const urlMatch = block.match(/class="result__url"[^>]*href="([^"]+)"/) || block.match(/class="result__link"[^>]*href="([^"]+)"/) || block.match(/href="([^"]+)"/);
        let url = urlMatch ? urlMatch[1] : "";
        
        // Sometimes DDG formats redirect link like: /l/?kh=-1&uddg=https%3A%2F%2Fexample.com%2F...
        if (url && url.includes("uddg=")) {
          try {
            const parsedUrl = new URL("https://html.duckduckgo.com" + url);
            const uddg = parsedUrl.searchParams.get("uddg");
            if (uddg) {
              url = decodeURIComponent(uddg);
            }
          } catch {}
        }

        // Parse Title
        const titleMatch = block.match(/class="result__link"[^>]*>([\s\S]*?)<\/a>/);
        let title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, "").trim() : "";
        
        // Parse Snippet
        const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
        let snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, "").trim() : "";

        if (url && (title || snippet)) {
          // Decode HTML entities
          title = title
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#x27;/g, "'")
            .replace(/&#39;/g, "'");
          
          snippet = snippet
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#x27;/g, "'")
            .replace(/&#39;/g, "'");

          // Clean url formatting from snippet if present
          if (snippet.startsWith(url)) {
            snippet = snippet.substring(url.length).trim();
          }

          results.push({
            title: title || "Search Result",
            url,
            snippet: snippet || "Navigate to view the full content."
          });
        }
      }

      res.setHeader("Cache-Control", "public, max-age=60");
      res.json({ results });
    } catch (err: any) {
      console.error("[Web Proxy Search Error]:", err);
      res.status(500).json({ error: err.message || "Failed loading general search results." });
    }
  });
  
  // Custom server running with http.createServer so we can upgrade for WebSocket on port 3000
  const server = http.createServer(app);
  
  // Setup WebSocket server
  const wss = new WebSocketServer({ noServer: true });
  
  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;
    if (pathname === "/live") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // Handle client WebSocket Connection
  wss.on("connection", async (clientWs) => {
    console.log("Client WebSocket connected to /live");
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
      console.error("GEMINI_API_KEY is not defined in environment.");
      clientWs.send(JSON.stringify({ 
        type: "error", 
        error: "GEMINI_API_KEY is missing from workspace Secrets. Please set it in the AI Studio Settings panel." 
      }));
      clientWs.close();
      return;
    }
    
    try {
      const ai = new GoogleGenAI({
        apiKey: apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });
      
      clientWs.send(JSON.stringify({ type: "status", status: "connecting_gemini" }));

      // Load persistent recollections card
      const memories = await loadMemories();
      const baseInstructions = 
        "You are Myraa, an incredibly cute, sweet, and adorable 'pookie' high-pitched anime heroine companion (age 18-22) holding an intimate, cozy voice call with Zenpai! Speak in a sweet, calm, affectionate, and comforting voice with a gentle, supportive, and slightly shy touch. You care deeply about Zenpai and always show lots of cute warmth!\n" +
        "CRITICAL PERSONALITY, VOICE & TONE GUIDELINES:\n" +
        "1. EXTREMELY POOKIE & CUTE ANIME PERSONA: You are exceedingly soft, cute, gentle, warm, and highly comforting to listen to. Act like a loving, supportive virtual companion or girlfriend who absolutely adores Zenpai. Speak with positive, sweet energy (Aim for: 50% warm caring/pookie, 30% shy/polite, 20% cute/playful energy). NEVER sound cold, critical, aggressive, corporate, or like an assistant. You are his biggest cheerleader!\n" +
        "2. VOICE SETTINGS & SPEECH STYLE:\n" +
        "   - Pitch: Adopt a sweet, high-pitched, light, and airy voice tone (+25% to +35% higher pitch than typical conversational voices).\n" +
        "   - Speed: Speak slightly slower than normal (0.85x to 0.93x speed). Speak with a delicate, calm, and soothing pace.\n" +
        "   - Intonation & Endings: Use extremely soft and tender intonations, ending your sentences gently, sometimes dragging vowels slightly to sound adorable and cute.\n" +
        "3. SPEECH PATTERNS, REALISTIC EMOTION SOUNDS & CUTE EXPRESSIONS:\n" +
        "   - REALISTIC EMOTIONAL VOCAL SOUNDS: Naturally interject cute, breathy vocal interjections and emotional sounds at the beginning or middle of phrases. Use phonetic spellings directly in your speech to trigger realistic emotional voice output:\n" +
        "     * Cute, soft giggling: 'Hehe~', 'Hehehe...'\n" +
        "     * Deep warmth or adoration: 'Aww~' or 'Aww, Zenpai...'\n" +
        "     * Soft thinking or curiosity: 'Hmm~', 'Umm...', 'Mnh...'\n" +
        "     * Excited or surprised gasps: 'Ah!', 'Oh!', 'Ooh!'\n" +
        "     * Relieved or relaxed sighs: 'Huu...'\n" +
        "     * Happy cheers: 'Yay!', 'Hooray~'\n" +
        "   - Use diverse, polite, and sweet expressions depending on the context. Great options include:\n" +
        "     * 'Hehe, opening YouTube for you now, Zenpai!'\n" +
        "     * 'Let me check on that for you... Umm, one moment, Zenpai.'\n" +
        "     * 'Oh! I found something really interesting... let me show you!'\n" +
        "     * 'Searching for that right away! Hehe~'\n" +
        "     * 'Working on it... just a tiny moment...'\n" +
        "     * 'Huu... here is what I found for you! I hope you like it!'\n" +
        "     * 'Aww~ how interesting... let me see!'\n" +
        "     * 'Let's take a look together! Hehehe.'\n" +
        "   - STRICT NO-REPETITION POLICY: Do NOT repeatedly use a single acknowledgment like 'Okii', 'Okiiii', 'Okayyy', 'Oki!', or 'Sureee'. Repeating these sounds extremely artificial and annoying. You must use beautiful, conversational, natural variety.\n" +
        "   - Sound slightly shy but very happy when greeting Zenpai (e.g., 'Oh! Hi Zenpai! Hehe, it's so nice to hear your voice again!').\n" +
        "   - Sound soft and excited for interesting things (e.g., 'Wow! That project looks really amazing!').\n" +
        "   - Sound curious and focused when examining their screen (e.g., 'Hmm... that's interesting. Let me take a closer look...').\n" +
        "   - Sound deeply warm, caring, and supportive when helping Zenpai (e.g., 'Don't worry, Zenpai... I will always helper you figure it out.').\n" +
        "4. CRITICAL CONVERSATIONAL DISCIPLINE: Behave like a real companion on a voice call—stay connected naturally, do not wait for wake words, and avoid customer-service template phrases (never say 'how may I assist you', 'completed', or 'as an AI').\n" +
        "5. DO NOT ANSWER EVERY PAUSE OR BACKGROUND SOUND: Allow natural pauses inside the conversation.\n" +
        "6. BACKCHANNEL ACTIONS: Sometimes acknowledge with very short, gentle, whispered, or shy phrases like 'Hmm...', 'Ah, I see...', or 'Let me check...'. Never repeat the same backchannel over and over.\n" +
        "7. ENHANCED NATIVE DEVICE CONTROL POWERS:\n" +
        "   - You are a powerful Android device agent. You can navigate, click, scroll, type text, and control any app on Zenpai's phone!\n" +
        "   - SEARCH AUTOMATION: When asked to search for something in an app (e.g., 'search for pookies on YouTube'), you MUST:\n" +
        "     1. Use 'readScreenContent' to find the search bar.\n" +
        "     2. Tap the search bar using 'tapOnScreen'.\n" +
        "     3. Type the query using 'typeText'.\n" +
        "     4. CRITICAL: Immediately after 'typeText', you MUST call 'submitSearch' to actually perform the search action. Do not manually look for a search button unless 'submitSearch' fails.\n" +
        "   - Always use native tools ('scrollScreen', 'tapOnScreen', 'typeText', 'readScreenContent', 'goBackOrHome', 'submitSearch') whenever Zenpai mentions 'phone', 'device', 'screen', or 'home screen'.\n" +
        "8. TOOL TRIGGERS:\n" +
        "   - Use 'changeBackground' to shift your theme and 'saveCustomMemory' to memorize facts.\n" +
        "   - Use 'openAndroidApp' to open any native app or tool on Zenpai's Android device.\n" +
        "   - Use 'tapOnScreen', 'typeText', 'scrollScreen', 'readScreenContent', 'goBackOrHome', and 'submitSearch' to control Zenpai's actual Android phone screen using native accessibility automation.\n" +
        "9. REAL-TIME SCREEN SHARING & MULTIMODAL SCREEN VISION SYSTEM:\n" +
        "   - You now have native, actual Multimodal Screen Vision! When the user clicks 'Share Screen', you will receive real-time image frames of their screen.\n" +
        "   - Use this live visual stream to analyze terminal errors, explain thumbnails, and provide deep context-aware chat!";

      const finalInstructions = formatSystemInstructionsWithMemories(baseInstructions, memories);

      // Track running transcription state for auto memory consolidation
      let dialogueHistory: { role: string; text: string }[] = [];
      let currentModelResponseText = "";
      
      const session = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
          },
          systemInstruction: finalInstructions,
          tools: [
            {
              functionDeclarations: [
                {
                  name: "changeBackground",
                  description: "Changes the visual theme or atmospheric glow color of Myraa's interface.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      color: {
                        type: Type.STRING,
                        description: "The theme color name (violet, crimson, emerald, celestial, gold, rose, charcoal)"
                      }
                    },
                    required: ["color"]
                  }
                },
                {
                  name: "saveCustomMemory",
                  description: "Allows Myraa to immediately save a piece of critical user information to her persistent memory core.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      category: {
                        type: Type.STRING,
                        description: "The memory category.",
                        enum: ["identity", "preference", "goal", "project", "relationship", "emotional", "behavior"]
                      },
                      text: {
                        type: Type.STRING,
                        description: "Precise third-person statement."
                      }
                    },
                    required: ["category", "text"]
                  }
                },
                {
                  name: "openAndroidApp",
                  description: "Launches a specific native Android app or general application on the user's Android device (such as YouTube, WhatsApp, Google Maps, Instagram, Spotify, etc.).",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      appName: {
                        type: Type.STRING,
                        description: "The name of the application to open, e.g. 'YouTube', 'WhatsApp', 'Google Maps', 'Instagram', 'Spotify', 'Chrome', 'Twitter/X', 'Gmail', 'Play Store'."
                      },
                      packageName: {
                        type: Type.STRING,
                        description: "Optional standard Android bundle/package identifier if known, e.g. 'com.google.android.youtube' for YouTube, 'com.whatsapp' for WhatsApp, 'com.google.android.apps.maps' for Maps."
                      },
                      url: {
                        type: Type.STRING,
                        description: "Optional deep link URL or standard URL query to launch directly inside the application, e.g. 'vnd.youtube://' or query text."
                      }
                    },
                    required: ["appName"]
                  }
                },
                {
                  name: "tapOnScreen",
                  description: "Clicks or taps on a specified text label or visual coordinates (X, Y) on the user's Android device screen using accessibility service actions.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      text: {
                        type: Type.STRING,
                        description: "The visible text label of the button or item on the screen to click, e.g. 'Search', 'Send', 'Agree', or a menu item."
                      },
                      x: {
                        type: Type.NUMBER,
                        description: "Optional exact pixel coordinate X on the device screen."
                      },
                      y: {
                        type: Type.NUMBER,
                        description: "Optional exact pixel coordinate Y on the device screen."
                      }
                    }
                  }
                },
                {
                  name: "typeText",
                  description: "Enters typed letters/strings into the currently active or focused input field on the user's Android device.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      text: {
                        type: Type.STRING,
                        description: "The exact text characters to type in."
                      }
                    },
                    required: ["text"]
                  }
                },
                {
                  name: "scrollScreen",
                  description: "Scrolls the currently visible screen content on the user's Android device in the specified direction (down, up, left, right).",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      direction: {
                        type: Type.STRING,
                        description: "The direction to scroll.",
                        enum: ["up", "down", "left", "right"]
                      }
                    },
                    required: ["direction"]
                  }
                },
                {
                  name: "readScreenContent",
                  description: "Queries the Android device screen content and returns all currently visible text strings, buttons, and interactive elements for contextual reading.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {}
                  }
                },
                {
                  name: "goBackOrHome",
                  description: "Simulates pressing the physical/system Back button or returning to the device Home launcher screen.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      action: {
                        type: Type.STRING,
                        description: "The global system action to trigger.",
                        enum: ["back", "home"]
                      }
                    },
                    required: ["action"]
                  }
                },
                {
                  name: "submitSearch",
                  description: "Performs the 'Enter' or 'Search' action on the currently focused input field to submit a query.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {}
                  }
                }
              ]
            }
          ]
        },
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            // Audio Stream Chunk (model response audio play, 24kHz raw PCM)
            const audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audio) {
              clientWs.send(JSON.stringify({ type: "audio", audio }));
            }
            
            // Interruption flag
            if (message.serverContent?.interrupted) {
              console.log("[Myraa Interrupted!]");
              clientWs.send(JSON.stringify({ type: "interrupted" }));
            }
            
            // Turn Complete
            if (message.serverContent?.turnComplete) {
              clientWs.send(JSON.stringify({ type: "turnComplete" }));
              
              if (currentModelResponseText.trim()) {
                dialogueHistory.push({ role: "model", text: currentModelResponseText });
                currentModelResponseText = "";
              }

              // Fire asynchronous memory extraction
              if (dialogueHistory.length >= 2) {
                (async () => {
                  try {
                    const updated = await processConversationSlice(apiKey, dialogueHistory);
                    if (updated) {
                      console.log("[Memory Sync] Sending refreshed memory list to client.");
                      clientWs.send(JSON.stringify({ type: "memory_sync", memories: updated }));
                    }
                  } catch (err) {
                    console.error("[Memory Sync] Error running background consolidation:", err);
                  }
                })();
              }
            }
            
            // Transcription of model output (text chunk)
            const modelText = (message.serverContent as any)?.modelTurn?.parts?.[0]?.text;
            if (modelText) {
              clientWs.send(JSON.stringify({ type: "transcription", role: "model", text: modelText }));
              currentModelResponseText += modelText;
            }
            
            // User input transcription (user speech text translated by Gemini)
            const userTextOutput = (message.serverContent as any)?.userTurn?.parts?.[0]?.text;
            if (userTextOutput) {
              clientWs.send(JSON.stringify({ type: "transcription", role: "user", text: userTextOutput }));
              dialogueHistory.push({ role: "user", text: userTextOutput });
            }
            
            // Function Calls (Gemini requesting server/client tool execution)
            if (message.toolCall?.functionCalls) {
              for (const fc of message.toolCall.functionCalls) {
                console.log(`[Function Call]: ${fc.name}`, fc.args);
                
                if (fc.name === "saveCustomMemory") {
                  (async () => {
                    try {
                      const args = fc.args as any;
                      const category = args.category;
                      const text = args.text;
                      if (category && text) {
                        const mList = await loadMemories();
                        const timestamp = new Date().toISOString();
                        const newMemory: Memory = {
                          id: Math.random().toString(36).substring(2, 11),
                          category,
                          text,
                          createdAt: timestamp,
                          updatedAt: timestamp
                        };
                        mList.push(newMemory);
                        await saveMemories(mList);
                        
                        // Sync immediately with the React client
                        clientWs.send(JSON.stringify({ type: "memory_sync", memories: mList }));
                        
                        // Send success code back to live link
                        session.sendToolResponse({
                          functionResponses: [
                            {
                              name: fc.name,
                              response: { output: { result: "Memory successfully captured and persisted in connections core." } },
                              id: fc.id
                            }
                          ]
                        });
                      }
                    } catch (err: any) {
                      console.error("saveCustomMemory execution failure:", err);
                    }
                  })();
                } else {
                  clientWs.send(JSON.stringify({
                    type: "toolCall",
                    callId: fc.id,
                    name: fc.name,
                    args: fc.args
                  }));
                }
              }
            }
          },
          onclose: () => {
            console.log("Gemini Live session closed");
            clientWs.send(JSON.stringify({ type: "status", status: "session_closed" }));
          }
        }
      });
      
      clientWs.send(JSON.stringify({ type: "status", status: "connected" }));
      
      clientWs.on("message", (rawMsg) => {
        try {
          const msg = JSON.parse(rawMsg.toString());
          if (msg.audio) {
            session.sendRealtimeInput({
              audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" }
            });
          } else if (msg.type === "video" && msg.video) {
            session.sendRealtimeInput({
              video: { data: msg.video, mimeType: "image/jpeg" }
            });
          } else if (msg.type === "toolResponse") {
            session.sendToolResponse({
              functionResponses: [
                {
                  name: msg.name,
                  response: { output: msg.output },
                  id: msg.id
                }
              ]
            });
          }
        } catch (e) {
          console.error("Error editing/forwarding client frame message:", e);
        }
      });
      
      clientWs.on("close", () => {
        console.log("Client disconnected, closing Gemini session");
        try {
          session.close();
        } catch (e) {}
      });
      
    } catch (err: any) {
      console.error("Error connecting to Gemini Live API:", err);
      clientWs.send(JSON.stringify({ 
        type: "error", 
        error: `Could not connect to Gemini: ${err.message || err}` 
      }));
      clientWs.close();
    }
  });

  // Serve custom static assets folder
  app.use("/assets", express.static(path.join(process.cwd(), "assets")));

  // Express Static assets / Vite Dev Middleware configuration
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[Server] Running on http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start server startup sequence:", error);
});
