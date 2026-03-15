
import { GoogleGenAI } from "@google/genai";
import { AppState, ClothingItem } from "../types";

// Helper to convert File to Base64
const fileToBase64 = async (file: File): Promise<string> => {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const base64String = result.split(',')[1];
      resolve(base64String);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

// New helper to fetch URL and convert to Part
const urlToPart = async (url: string) => {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch image: ${url}`);
    const blob = await response.blob();
    // We treat downloaded blobs as png/jpeg based on their type, defaulting to jpeg if unknown
    const mimeType = blob.type || 'image/jpeg';
    const base64String = await fileToBase64(new File([blob], "image", { type: mimeType }));
    
    return {
      inlineData: {
        data: base64String,
        mimeType: mimeType
      }
    };
  } catch (error) {
    console.error("Error fetching preset image:", error);
    throw error;
  }
};

const processItem = async (item: ClothingItem) => {
  if (item.file) {
    const base64 = await fileToBase64(item.file);
    return {
      inlineData: {
        data: base64,
        mimeType: item.file.type
      }
    };
  } else if (item.previewUrl) {
    return await urlToPart(item.previewUrl);
  }
  throw new Error("Invalid item: no file or url");
};

export const generateOutfit = async (state: AppState): Promise<string> => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) throw new Error("API Key not found");

  const ai = new GoogleGenAI({ apiKey });

  // Prepare the content parts
  const parts: any[] = [];

  // Helper to add image if exists and record its index
  const addImagePart = async (file: File | null, url: string | null, label: string) => {
    if (file) {
      const part = await processItem({ id: 'temp', file, previewUrl: '' });
      parts.push(part);
      return `[IMAGE_${parts.length}]`;
    } else if (url) {
       const part = await urlToPart(url);
       parts.push(part);
       return `[IMAGE_${parts.length}]`;
    }
    return "NO_IMAGE_PROVIDED";
  };

  // Helper for arrays of items
  const addImageParts = async (items: ClothingItem[]) => {
    if (items.length === 0) return "NO_IMAGE_PROVIDED";
    
    const refs = [];
    for (const item of items) {
      try {
        const part = await processItem(item);
        parts.push(part);
        refs.push(`[IMAGE_${parts.length}]`);
      } catch (e) {
        console.warn("Skipping invalid item", e);
      }
    }
    return refs.join(", ");
  };

  // 1. Profile
  const profileRef = await addImagePart(state.profilePhoto, state.profilePreviewUrl, "PROFILE_IMAGE");

  // 2. Clothing Parts (Handling arrays)
  const headRef = await addImageParts(state.wardrobe.headwear);
  const uOuterRef = await addImageParts(state.wardrobe.upperBody);
  const lOuterRef = await addImageParts(state.wardrobe.lowerBody);
  const footRef = await addImageParts(state.wardrobe.footwear);
  const accRef = await addImageParts(state.wardrobe.accessories);

  // Construct the prompt using the specific format required
  let promptText = `
You are an AI outfit renderer for an image-try-on website.

The website will ALWAYS provide you with structured inputs from placeholders:

1) User inputs
- profile_photo: ${profileRef}

2) Clothing image placeholders (Lists of images for each slot)

- headwear: ${headRef}

- upper_body:
  - items: ${uOuterRef}

- lower_body:
  - items: ${lOuterRef}

- footwear: ${footRef}

- accessories:
  - items: ${accRef}

3) Request context
- request_type: "new_generation"

------------------------------------------------------------
YOUR GOAL

Generate 1 high-quality photorealistic image of THE SAME PERSON as in profile_photo, wearing the items provided.

------------------------------------------------------------
HARD RULES

1. Identity & Body
- Preserve the user’s identity (face, hair, skin tone) from profile_photo.
- Infer the user's gender and body shape directly from the profile_photo.

2. Clothing
- Apply 'headwear' if provided.
- Apply ALL 'upper_body' items to the torso (layering them if multiple, e.g. shirt + jacket).
- Apply ALL 'lower_body' items to the legs.
- Apply 'footwear' to the feet.
- Apply 'accessories' where appropriate.
- If a slot is missing (NO_IMAGE_PROVIDED), infer a neutral basic item that matches the outfit to complete the look.

3. Style & Quality
- Generate a clean, professional, photorealistic studio look.
- No artifacts, natural lighting and shadows.
- Correct anatomical proportions.
  `;

  // Add the text prompt as the final part
  parts.push({ text: promptText });

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-image-preview',
      contents: { parts },
    });

    // The response might contain an image or text.
    // We iterate to find the image part.
    const candidates = response.candidates;
    if (candidates && candidates.length > 0) {
      const content = candidates[0].content;
      for (const part of content.parts) {
        if (part.inlineData) {
          return `data:image/png;base64,${part.inlineData.data}`;
        }
      }
    }
    
    // Fallback if no image found directly
    throw new Error("No image generated.");
  } catch (error) {
    console.error("Gemini API Error:", error);
    throw error;
  }
};

export const generateOutfitVideo = async (imageUrl: string, prompt?: string): Promise<string> => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) throw new Error("API Key not found");

  const ai = new GoogleGenAI({ apiKey });

  // Extract base64 and mimeType from data URL
  const matches = imageUrl.match(/^data:(.+);base64,(.+)$/);
  if (!matches || matches.length !== 3) {
    throw new Error("Invalid image URL format");
  }
  const mimeType = matches[1];
  const base64EncodeString = matches[2];

  const defaultPrompt = 'A 360 degree video showing the person and their outfit from every angle, rotating smoothly.';
  const finalPrompt = prompt ? `${prompt}. High quality, photorealistic, smooth motion.` : defaultPrompt;

  let operation = await ai.models.generateVideos({
    model: 'veo-3.1-fast-generate-preview',
    prompt: finalPrompt,
    image: {
      imageBytes: base64EncodeString,
      mimeType: mimeType,
    },
    config: {
      numberOfVideos: 1,
      resolution: '720p',
      aspectRatio: '9:16'
    }
  });

  let currentApiKey = apiKey;
  while (!operation.done) {
    await new Promise(resolve => setTimeout(resolve, 10000));
    // Re-instantiate to ensure we have the latest API key if it was updated
    currentApiKey = process.env.API_KEY || apiKey;
    if (!currentApiKey) throw new Error("API Key not found during polling");
    const currentAi = new GoogleGenAI({ apiKey: currentApiKey });
    
    try {
        // The SDK expects the operation object itself or { name: operation.name }
        operation = await currentAi.operations.getVideosOperation({ operation: operation });
    } catch (e) {
        console.error("Error polling operation:", e);
        // Sometimes the API returns 404 or other errors temporarily, we can retry a few times
        // but for now we'll just throw
        throw e;
    }
  }

  // Check if the operation has an error
  if (operation.error) {
    console.error("Video generation operation failed:", operation.error);
    throw new Error(`Video generation failed: ${operation.error.message || 'Unknown error'}`);
  }

  const downloadLink = operation.response?.generatedVideos?.[0]?.video?.uri;
  if (!downloadLink) {
    console.error("Operation completed but no video URI found:", operation);
    throw new Error("No video generated. The operation may have failed or been blocked.");
  }

  const response = await fetch(downloadLink, {
    method: 'GET',
    headers: {
      'x-goog-api-key': currentApiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch video: ${response.statusText}`);
  }

  const blob = await response.blob();
  return URL.createObjectURL(blob);
};
