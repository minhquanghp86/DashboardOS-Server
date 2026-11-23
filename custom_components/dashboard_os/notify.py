"""dashboard_os.send: gui thong bao uu tien cao toi man hinh Dashboard OS."""
from __future__ import annotations

import logging
import mimetypes
from pathlib import Path

import aiohttp
import voluptuous as vol

from homeassistant.components.notify import NotifyEntity, NotifyEntityFeature
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

SERVICE_SEND = "send"
# (27/10/2026) Ưu tiên chọn được: urgent (mặc định, mở khoá + phủ toàn màn), critical, high, normal.
PRIORITY = "urgent"

SERVICE_SCHEMA = vol.Schema(
    {
        vol.Optional("message", default=""): cv.string,
        vol.Optional("title", default=""): cv.string,
        vol.Optional("duration", default=10): vol.Any(cv.string, vol.All(vol.Coerce(int), vol.Range(min=0, max=600))),
        vol.Optional("device"): vol.Any(cv.string, [cv.string]),
        vol.Optional("image"): cv.string,
        vol.Optional("video"): cv.string,
        vol.Optional("audio"): cv.string,
        vol.Optional("camera"): cv.string,
        vol.Optional("camera_stream"): cv.string,
        # (23/11/2026) Lap kin khung (cover, cat 2 mep) thay vi letterbox — huu ich cho man vuong 480x480.
        vol.Optional("fill"): cv.boolean,
        vol.Optional("priority", default="urgent"): vol.In(["urgent", "critical", "high", "normal"]),
    }
)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    entity = DashboardOSNotify(hass, entry)
    async_add_entities([entity])

    async def handle(call: ServiceCall) -> None:
        data = dict(call.data)
        message = data.pop("message", "")
        title = data.pop("title", None)
        await entity.send(message, title, data)

    if not hass.services.has_service(DOMAIN, SERVICE_SEND):
        hass.services.async_register(
            DOMAIN, SERVICE_SEND, handle, schema=SERVICE_SCHEMA
        )


class DashboardOSNotify(NotifyEntity):
    """Entity notify.dashboard_os (dung cho notify.send_message)."""

    _attr_name = "dashboard_os"
    _attr_supported_features = NotifyEntityFeature.TITLE

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self._base = str(entry.data[CONF_HOST]).rstrip("/")
        self._attr_unique_id = f"{entry.entry_id}_notify"

    async def async_send_message(
        self, message: str, title: str | None = None, **kwargs
    ) -> None:
        await self.send(message, title, kwargs.get("data") or {})

    async def _resolve_device(self, value: str) -> str:
        """device_id cua Home Assistant -> id firmware esp32-<mac>; 'all' giu nguyen."""
        if not value or value == "all":
            return "all"
        if value.startswith("esp32-"):
            return value
        dev = dr.async_get(self.hass).async_get(value)
        if dev is None:
            return value
        for domain, ident in dev.identifiers:
            if domain == DOMAIN and ident.startswith("esp32-"):
                return ident
        for conn_type, conn_id in dev.connections:
            if str(conn_type) == "mac":
                return "esp32-" + conn_id.replace(":", "").replace("-", "").lower()
        return value

    async def send(self, message: str, title: str | None, data: dict) -> None:
        if not isinstance(data, dict):
            data = {}

        duration = data.get("duration")
        try:
            duration = int(duration) if duration is not None else 10
        except (TypeError, ValueError):
            duration = 10
        duration = max(0, min(600, duration))
        duration = max(0, min(600, duration))

        devices = data.get("device")
        if isinstance(devices, str):
            devices = [devices]
        if not devices:
            targets = ["all"]
        else:
            targets = [await self._resolve_device(str(d)) for d in devices if d]

        camera = str(data.get("camera") or "")
        if camera.startswith("camera."):
            camera = camera[7:]
        if stream := data.get("camera_stream"):
            camera = str(stream)

        media: dict[str, str] = {}
        for key in ("image", "video", "audio"):
            if src := data.get(key):
                if url := await self._to_url(str(src), key):
                    media[key] = url

        session = async_get_clientsession(self.hass)
        for target in targets:
            payload: dict[str, object] = {
                "title": title or "",
                "message": message or "",
                "priority": str(data.get("priority") or PRIORITY),
                "duration": duration,
                "device": target,
                **media,
            }
            if camera:
                payload["camera"] = camera
            if (fill := data.get("fill")) is not None:
                payload["fill"] = bool(fill)
            try:
                async with session.post(
                    f"{self._base}/notify",
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=15),
                ) as resp:
                    if resp.status >= 400:
                        raise HomeAssistantError(
                            f"Dashboard OS tra loi HTTP {resp.status}: {await resp.text()}"
                        )
            except aiohttp.ClientError as err:
                raise HomeAssistantError(
                    f"Khong ket noi duoc Dashboard OS: {err}"
                ) from err

    async def _to_url(self, src: str, kind: str) -> str | None:
        if src.startswith("media-source://"):
            try:
                from homeassistant.components import media_source

                item = await media_source.async_resolve_media(self.hass, src, None)
                base = self.hass.config.internal_url or self.hass.config.external_url or ""
                download = item.url if item.url.startswith(("http://", "https://")) else base + item.url
                session = async_get_clientsession(self.hass)
                async with session.get(download, timeout=aiohttp.ClientTimeout(total=180)) as got:
                    if got.status >= 400:
                        _LOGGER.warning("Dashboard OS: tai media that bai HTTP %s", got.status)
                        return None
                    body = await got.read()
                    ctype = got.headers.get("Content-Type", "application/octet-stream")
                return await self._upload(body, ctype, kind)
            except HomeAssistantError:
                raise
            except Exception as err:
                _LOGGER.warning("Dashboard OS: khong doc duoc media-source %s: %s", src, err)
                return None
        if src.startswith(("http://", "https://")):
            return src
        path = Path(src)
        if not path.is_absolute():
            path = Path(self.hass.config.config_dir) / src
        if not path.exists():
            _LOGGER.warning("Dashboard OS: khong tim thay file %s", path)
            return None
        body = await self.hass.async_add_executor_job(path.read_bytes)
        ctype, _ = mimetypes.guess_type(str(path))
        return await self._upload(body, ctype or "application/octet-stream", kind)

    async def _upload(self, body: bytes, ctype: str, kind: str) -> str | None:
        session = async_get_clientsession(self.hass)
        try:
            async with session.post(
                f"{self._base}/notify/upload",
                data=body,
                headers={"Content-Type": ctype, "X-Media-Kind": kind},
                timeout=aiohttp.ClientTimeout(total=180),
            ) as resp:
                if resp.status >= 400:
                    raise HomeAssistantError(f"Tai {kind} len that bai: HTTP {resp.status}")
                return (await resp.json()).get("url")
        except aiohttp.ClientError as err:
            raise HomeAssistantError(f"Tai {kind} len that bai: {err}") from err
