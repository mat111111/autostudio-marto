"""Adaptador del SDK `google-genai` al `ModelClient` del director. Corre SOLO en el backend.

Detalle clave de Gemini 3: en function calling hay que reenviar el contenido del modelo EXACTAMENTE como
llegó (incluye las "thought signatures"); si se reconstruye a mano, la API responde 400. Por eso se guarda
`raw` (el `Content` original) y se reutiliza.
"""
from __future__ import annotations

from typing import Any

from .director import DirectorError, ModelReply, ToolCall


class GeminiClient:
    def __init__(self, api_key: str, model: str):
        if not api_key:
            raise DirectorError("Falta GEMINI_API_KEY en el backend.")
        from google import genai  # import tardío: el resto del sistema funciona sin el SDK
        self._genai = genai
        self._client = genai.Client(api_key=api_key)
        self.model = model

    def generate(self, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> ModelReply:
        from google.genai import types

        contents = []
        for m in messages:
            if m["role"] == "user":
                contents.append(types.Content(role="user", parts=[types.Part.from_text(text=m["text"])]))
            elif m["role"] == "model":
                if m.get("raw") is not None:
                    contents.append(m["raw"])  # intacto, con thought signatures
                else:
                    parts = [types.Part.from_text(text=m["text"])] if m.get("text") else []
                    parts += [types.Part.from_function_call(name=c.name, args=c.args) for c in m.get("calls", [])]
                    contents.append(types.Content(role="model", parts=parts))
            elif m["role"] == "tool":
                contents.append(types.Content(role="user", parts=[
                    types.Part.from_function_response(name=r["name"], response=r["response"])
                    for r in m["results"]]))

        config = types.GenerateContentConfig(
            system_instruction=system,
            tools=[types.Tool(function_declarations=tools)],
            # El bucle de herramientas lo manejamos nosotros para validar y registrar cada operación.
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        )
        try:
            resp = self._client.models.generate_content(model=self.model, contents=contents, config=config)
        except Exception as e:  # errores de red/cuota/clave: se informan sin tocar el proyecto
            raise DirectorError(f"Falló la llamada a Gemini: {e}") from e

        if not resp.candidates or resp.candidates[0].content is None:
            raise DirectorError("Gemini no devolvió contenido (posible bloqueo de seguridad). Probá reformular el pedido.")
        content = resp.candidates[0].content
        calls = [ToolCall(name=fc.name, args=dict(fc.args or {})) for fc in (resp.function_calls or [])]
        text = "".join(p.text for p in (content.parts or []) if getattr(p, "text", None) and not getattr(p, "thought", False))
        return ModelReply(text=text, calls=calls, raw=content)
