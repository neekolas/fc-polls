import type { NextApiRequest, NextApiResponse } from "next";
import { Poll } from "@/app/types";
import { kv } from "@vercel/kv";
import { validateFramesPost } from "@xmtp/frames-validator";
import { getSSLHubRpcClient, Message } from "@farcaster/hub-nodejs";

const HUB_URL = process.env["HUB_URL"] || "nemes.farcaster.xyz:2283";
const client = getSSLHubRpcClient(HUB_URL);

async function validateFarcasterMessage(
  frameMessageBytes: Buffer
): Promise<string> {
  const frameMessage = Message.decode(frameMessageBytes);
  const result = await client.validateMessage(frameMessage);
  if (result.isOk() && result.value.valid) {
    const fid = result.value.message?.data?.fid?.toString();
    if (fid) {
      return fid;
    }
  }
  throw new Error("Failed to validate message");
}

async function validateMessage(body: any): Promise<string> {
  if (body?.untrustedData?.walletAddress) {
    const data = await validateFramesPost(body);
    return data?.verifiedWalletAddress;
  }

  return validateFarcasterMessage(
    Buffer.from(body?.trustedData?.messageBytes || "", "hex")
  );
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === "POST") {
    // Process the vote
    // For example, let's assume you receive an option in the body
    try {
      const pollId = req.query["id"];
      const results = req.query["results"] === "true";
      const createPoll = req.query["createPoll"] === "true";
      let voted = req.query["voted"] === "true";
      if (!pollId) {
        return res.status(400).send("Missing poll ID");
      }

      let identifier: string;
      try {
        identifier = await validateMessage(req.body);
      } catch (e) {
        console.error(e);
        return res.status(400).send(`Failed to validate message: ${e}`);
      }

      // const buttonId = validatedMessage?.data?.frameActionBody?.buttonIndex || 0;
      // const fid = validatedMessage?.data?.fid || 0;

      // Use untrusted data for testing
      const buttonId = req.body?.untrustedData?.buttonIndex || 0;

      const voteExists = await kv.sismember(`poll:${pollId}:voted`, identifier);
      voted = voted || !!voteExists;

      // Clicked create poll
      if (createPoll) {
        return res
          .status(302)
          .setHeader("Location", `${process.env["HOST"]}`)
          .send("Redirecting to create poll");
      }

      if (identifier && buttonId > 0 && buttonId < 5 && !results && !voted) {
        let multi = kv.multi();
        multi.hincrby(`poll:${pollId}`, `votes${buttonId}`, 1);
        multi.sadd(`poll:${pollId}:voted`, identifier);
        await multi.exec();
      }

      let poll: Poll | null = await kv.hgetall(`poll:${pollId}`);

      if (!poll) {
        return res.status(400).send("Missing poll ID");
      }
      const imageUrl = `${process.env["HOST"]}/api/image?id=${
        poll.id
      }&results=${results ? "false" : "true"}&date=${Date.now()}${
        identifier ? `&fid=${identifier}` : ""
      }`;
      let button1Text = "View Results";
      if (!voted && !results) {
        button1Text = "Back";
      } else if (voted && !results) {
        button1Text = "Already Voted";
      } else if (voted && results) {
        button1Text = "View Results";
      }

      // Return an HTML response
      res.setHeader("Content-Type", "text/html");
      res.status(200).send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Vote Recorded</title>
          <meta property="og:title" content="Vote Recorded">
          <meta property="og:image" content="${imageUrl}">
          <meta property="fc:frame" content="vNext">
          <meta property="fc:frame:image" content="${imageUrl}">
          <meta property="fc:frame:post_url" content="${
            process.env["HOST"]
          }/api/vote?id=${poll.id}&voted=true&results=${
        results ? "false" : "true"
      }">
          <meta property="fc:frame:button:1" content="${button1Text}">
          <meta property="fc:frame:button:2" content="Create your poll">
          <meta property="fc:frame:button:2:action" content="post_redirect">
          <meta property="fc:frame:button:2:target" content=""${
            process.env["HOST"]
          }/api/vote?id=${poll.id}&results=true&createPoll=true">
        </head>
        <body>
          <p>${
            results || voted
              ? `You have already voted. You clicked ${buttonId}`
              : `Your vote for ${buttonId} has been recorded for ${identifier}.`
          }</p>
        </body>
      </html>
    `);
    } catch (error) {
      console.error(error);
      res.status(500).send("Error generating image");
    }
  } else {
    // Handle any non-POST requests
    res.setHeader("Allow", ["POST"]);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}
