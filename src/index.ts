export default {
  async fetch(): Promise<Response> {
    return new Response("beacon", { status: 200 });
  }
} satisfies ExportedHandler;
