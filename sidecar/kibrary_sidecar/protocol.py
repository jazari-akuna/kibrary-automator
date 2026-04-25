from typing import Any, Literal, Optional
from pydantic import BaseModel

class Request(BaseModel):
    id: int
    method: str
    params: dict[str, Any] = {}

class ErrorBody(BaseModel):
    code: str
    message: str

class Response(BaseModel):
    id: int
    ok: bool
    result: Optional[Any] = None
    error: Optional[ErrorBody] = None

class Notification(BaseModel):
    event: str
    params: dict[str, Any] = {}

class ParsedRow(BaseModel):
    lcsc: str
    qty: int
    ok: bool
    error: Optional[str] = None

class ParseResult(BaseModel):
    rows: list[ParsedRow]
    format: Literal["bom", "list"]
