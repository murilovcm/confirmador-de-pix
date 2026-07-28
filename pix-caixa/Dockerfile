FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=8000 DB_PATH=/data/pix.db PYTHONUNBUFFERED=1
EXPOSE 8000

CMD gunicorn -w 2 -t 60 -b 0.0.0.0:${PORT} --access-logfile - app:app
