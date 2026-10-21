import dotenv from "dotenv" 

dotenv.config()



function log(step: string, value: string): void {
  console.log(`  [voice:${step}] ${value}`);
}


export async function handleTwiAudio(audio : string){
    const twiText = await twiSTT(audio)
    const englishText = await twiToEnglish(twiText)

    return englishText
}


export async function handleEnglishToTwi(text: string): Promise<string> {
  return englishToTwi(text);
}


export async function twiToEnglish(text : string){
  const headers = new Headers()
  headers.set("Ocp-Apim-Subscription-Key" , process.env.GHNLP_API_KEY as string)
  headers.set("Content-Type" , "application/json")
  const request = await fetch("https://translation-api.ghananlp.org/v1/translate" , {
    method : "POST" , 
    headers : headers,
    body : JSON.stringify({
      in : text , 
      lang : "tw-en"
    })
  })

  if(request.status != 200) throw new Error("Translation error") 

  const response = await request.json() 

  return response
}


export async function englishToTwi(text: string): Promise<string> {
  const headers = new Headers()
  headers.set("Ocp-Apim-Subscription-Key", process.env.GHNLP_API_KEY as string)
  headers.set("Content-Type", "application/json")
  const request = await fetch("https://translation-api.ghananlp.org/v1/translate", {
    method: "POST",
    headers: headers,
    body: JSON.stringify({
      in: text,
      lang: "en-tw"
    })
  })

  if (request.status != 200) throw new Error("Translation error (en→tw)")

  const response = await request.json()
  return response
}


async function twiSTT(base64Audio : string){
  const cleanedBase64 = base64Audio.includes(",")
      ? base64Audio.split(",")[1]
      : base64Audio;

    const byteCharacters = atob(cleanedBase64);
    const byteNumbers = new Array(byteCharacters.length)
      .fill(0)
      .map((_, i) => byteCharacters.charCodeAt(i));

    const byteArray = new Uint8Array(byteNumbers);

    const audioBlob = new Blob([byteArray], { type: "audio/mpeg" });

  const headers = new Headers()

  headers.set("Ocp-Apim-Subscription-Key" , process.env.GHNLP_API_KEY as string)
  headers.set("Content-Type" , "audio/mpeg")

  const request = await fetch("https://translation-api.ghananlp.org/asr/v1/transcribe?language=tw" , {
    method : "POST" , 
    body : audioBlob , 
    headers : headers
  })

  if(request.status != 200) throw new Error("Transcription error")

  const response = await request.json()

  return response
}


export async function twiTTS(text: string): Promise<Buffer> {
  const headers = new Headers()
  headers.set("Ocp-Apim-Subscription-Key", process.env.GHNLP_API_KEY as string)
  headers.set("Content-Type", "application/json")

  const request = await fetch("https://translation-api.ghananlp.org/tts/v1/synthesize", {
    method: "POST",
    headers: headers,
    body: JSON.stringify({
      text: text,
      language: "tw",
      voice: "female"
    })
  })

  if (request.status != 200) throw new Error("TTS error (Twi)")

  const arrayBuffer = await request.arrayBuffer()
  return Buffer.from(arrayBuffer)
}