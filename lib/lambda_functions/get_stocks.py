from datetime import datetime
import os
import json
from alpaca.trading.client import TradingClient
from alpaca.trading.requests import GetAssetsRequest
import pytz
import boto3
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def get_all_assets(event, context):
    API_KEY = os.environ['ALPACA_API_KEY']
    SECRET_KEY = os.environ['ALPACA_API_SECRET']
    BUCKET_NAME = os.environ['BUCKET_NAME']
    PAGE_SIZE = 1000  # Adjust this according to your payload size preference

    trading_client = TradingClient(API_KEY, SECRET_KEY)
    bucket = boto3.client('s3')

    utc_now = datetime.utcnow().replace(tzinfo=pytz.utc)
    cdt_now = utc_now.astimezone(pytz.timezone('America/Chicago'))
    current_date_str = cdt_now.strftime('%Y_%m_%d_%H_%M_%S')
    search_params = GetAssetsRequest(status='active', page_count=PAGE_SIZE)

    try:
        asset_generator = trading_client.get_all_assets(search_params)
        total_assets = []
        page_count = 0
        for asset in asset_generator:
            total_assets.append(asset)
            if len(total_assets) == PAGE_SIZE:
                save_assets_to_s3(bucket, BUCKET_NAME,
                                  total_assets, current_date_str, page_count)
                page_count += 1
                total_assets = []

        # Save remaining assets if there are any
        if total_assets:
            save_assets_to_s3(bucket, BUCKET_NAME, total_assets,
                              current_date_str, page_count)

        return {
            'statusCode': 200,
            'body': json.dumps({'message': 'Assets saved successfully', 'page_count': page_count, 'total_assets': len(total_assets)})
        }

    except Exception as e:
        logger.error(f'Error: {e}')
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }


def save_assets_to_s3(bucket, bucket_name, assets, current_date_str, page_count):
    serializable_assets = [
        {
            'class': asset.asset_class,
            'symbol': asset.symbol,
            'name': asset.name,
            'price_increment': str(asset.price_increment),
            'exchange': asset.exchange,
            'status': asset.status,
            'attributes': asset.attributes,
            'tradable': str(asset.tradable),
            'marginable': str(asset.marginable),
            'shortable': str(asset.shortable),
            'easy_to_borrow': str(asset.easy_to_borrow),
            'fractionable': str(asset.fractionable),
            'min_order_size': str(asset.min_order_size),
            'min_trade_increment': str(asset.min_trade_increment),
            'maintenance_margin_requirement': str(asset.maintenance_margin_requirement)
        }
        for asset in assets
    ]

    file_name = f'assets/stocks_data_{current_date_str}_page_{page_count}.json'
    ndjson_result = '\n'.join([json.dumps(asset)
                              for asset in serializable_assets])
    bucket.put_object(Bucket=bucket_name, Body=ndjson_result, Key=file_name)

    logger.info(f'Successfully saved assets to {file_name}')
