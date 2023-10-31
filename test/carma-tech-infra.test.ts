import { StockUltimateStack } from "../lib/stock_ultimate-stack";
import { expect as expectCDK, haveResource } from "@aws-cdk/assert";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import exp = require("constants");
import 'dotenv/config';
import { CARMATECH_CONFIG } from "../lib/configuration";

jest.mock('../lib/configuration');

const app = new App();
const stockStack = new StockUltimateStack(app, 'StockTestStack', {
    env: {
        account: CARMATECH_CONFIG.Prod.ACCOUNT_ID,
        region: CARMATECH_CONFIG.Prod.REGION,
    },
});

function expectStackToHaveResource(resourceType: string, properties?: any) {
    expectCDK(stockStack).to(haveResource(resourceType, properties));
}
describe('Stock Ultimate Stack', () => {
    const template = Template.fromStack(stockStack);
    it('snapshot test', () => {
        expect(template.toJSON()).toMatchSnapshot();
    });
    describe('Resources existence', () => {
        it('stack should have a bucket name', () => {
            expectStackToHaveResource('AWS::S3::Bucket', {
                BucketName: 'stock-ultimate-bucket'
            })
        });
        it('stack should have a lambda function', () => {
            expectStackToHaveResource('AWS::Lambda::Function', {
                FunctionName: 'StockUltimateFunction',
            })
        });
    })
});