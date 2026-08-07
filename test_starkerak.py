import asyncio
from starkerak import StarKerakClient
import os

client = StarKerakClient(os.environ["STARKERAK_API_KEY"])

@client.on_payment
def tolov_kelganda(payment):
    print("Pul tushdi!", payment)

client.start_listening()
